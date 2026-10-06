// Optional browser integration check. Uses real downloaded EBS assets and isolated
// Firebase mocks; never writes to production. Set PLAYWRIGHT_MODULE_PATH if needed.
const { createServer } = require('node:http');
const { readFile } = require('node:fs/promises');
const { resolve } = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');

(async () => {
  const { prepareExam, publicPreview, downloadExamAudio } = await import('../import-service.js');
  const exam = await prepareExam({ year: 2025, grade: '중1', session: 1 });
  const preview = publicPreview(exam), audio = await downloadExamAudio(exam);
  const root = resolve(__dirname, '../..');
  const files = new Set(['teacher.html', 'teacher.js', 'index.html', 'student.js', 'styles.css', 'auto-import.js', 'round-script.js', 'question-groups.js']);
  const server = createServer(async (req, res) => {
    const file = new URL(req.url, 'http://localhost').pathname.slice(1);
    if (!files.has(file)) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(await readFile(resolve(root, file)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1250, height: 950 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.dismiss());
    await page.addInitScript(() => { window.__testFirebase = { docs: {}, progress: {}, activityLogs: {}, uploads: [], attempts: [], nextId: 0, failUpload: false, failWrite: false }; });
    await page.route('**/firebase.js', route => route.fulfill({ contentType: 'text/javascript', body: 'export const db={}; export const storage={};' }));
    await page.route('**/firebase-firestore.js', route => route.fulfill({ contentType: 'text/javascript', body: `
      export function collection(db,name){return {name};}
      export function doc(parent,...args){return args.length?{name:args[0],id:args[1]}:{name:parent.name,id:'test-'+(++window.__testFirebase.nextId)};}
      export async function getDocs(ref){const t=window.__testFirebase;return {docs:Object.entries(ref.name==='rounds'?t.docs:t[ref.name]||{}).map(([id,data])=>({id,data:()=>data}))};}
      export async function getDoc(ref){const t=window.__testFirebase,data=ref.name==='students'?{name:'검증 학생'}:(ref.name==='rounds'?t.docs:t[ref.name]||{})[ref.id];return {exists:()=>!!data,data:()=>data};}
      export function serverTimestamp(){return {seconds:12345};}
      export async function setDoc(ref,data){const t=window.__testFirebase;t.attempts.push(ref.id);if(t.failWrite){t.failWrite=false;throw new Error('test write failure');}t.docs[ref.id]=data;}
      export async function updateDoc(ref,data){Object.assign(window.__testFirebase.docs[ref.id],data);}
      export async function addDoc(ref,data){const d=doc(ref);await setDoc(d,data);return d;}
      export async function deleteDoc(ref){delete window.__testFirebase.docs[ref.id];}
      export async function runTransaction(db,callback){return callback({get:getDoc,set(ref,data){const t=window.__testFirebase,store=ref.name==='rounds'?t.docs:t[ref.name];store[ref.id]={...store[ref.id],...data};}});}
    ` }));
    await page.route('**/firebase-storage.js', route => route.fulfill({ contentType: 'text/javascript', body: `
      export function ref(storage,path){return {path};}
      export async function uploadBytes(ref,blob){const t=window.__testFirebase;if(t.failUpload){t.failUpload=false;throw new Error('test upload failure');}t.uploads.push({path:ref.path,size:blob.size});}
      export async function getDownloadURL(){return '${origin}/test-audio.mp3';}
      export async function deleteObject(){}
    ` }));
    let failPartial = false;
    await page.route('**/api/past-exam/**', async route => {
      const action = new URL(route.request().url()).pathname.split('/').at(-1);
      if (action === 'prepare') return route.fulfill({ json: preview });
      if (failPartial) return route.fulfill({ status: 422, json: { error: '검증용 서비스 실패' } });
      if (action === 'audio') return route.fulfill({ contentType: 'audio/mpeg', body: audio });
      return route.fulfill({ json: { questions: preview.questions.map(q => ({ ...q, rows: q.rows.map(row => ({ ...row, korean: '[검증용 해석]' })) })), warnings: [] } });
    });
    await page.route('**/test-audio.mp3', route => {
      const range = route.request().headers().range?.match(/bytes=(\d+)-(\d*)/);
      if (!range) return route.fulfill({ contentType: 'audio/mpeg', headers: { 'Accept-Ranges': 'bytes' }, body: audio });
      const start = Number(range[1]), end = range[2] ? Math.min(Number(range[2]), audio.length - 1) : audio.length - 1;
      return route.fulfill({ status: 206, contentType: 'audio/mpeg', headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${audio.length}` }, body: audio.subarray(start, end + 1) });
    });
    await page.goto(`${origin}/teacher.html`);
    await page.getByRole('button', { name: '회차·대본·음원', exact: true }).click();
    await page.locator('#importExamBtn').click();
    await page.locator('#importStatus').filter({ hasText: '미리보기 준비 완료' }).waitFor();
    assert.equal(await page.locator('#importQuestions .preview-q').count(), 20);
    assert.equal(await page.locator('#importSources a').count(), 4);
    assert.ok((await page.locator('#importScript').inputValue()).includes('[검증용 해석]'));
    await page.waitForFunction(() => Number.isFinite(document.getElementById('importAudio').duration));
    const duration = await page.locator('#importAudio').evaluate(audio => audio.duration);
    assert.ok(duration > 600 && duration < 2400, `Unexpected full-exam MP3 duration: ${duration}`);
    assert.deepEqual(await page.evaluate(() => [Object.keys(window.__testFirebase.docs).length, window.__testFirebase.uploads.length]), [0, 0]);
    const edited = (await page.locator('#importScript').inputValue()).replace('[검증용 해석]', '교사가 수정한 해석');
    await page.locator('#importScript').fill(edited);
    await page.locator('#importTitle').fill('교사 확인 테스트');
    await page.evaluate(() => { window.__testFirebase.failUpload = true; });
    await page.locator('#importSaveBtn').click();
    await page.locator('#importStatus').filter({ hasText: 'Storage 업로드에 실패' }).waitFor();
    assert.equal(await page.locator('#importScript').inputValue(), edited);
    await page.evaluate(() => { window.__testFirebase.failWrite = true; });
    await page.locator('#importSaveBtn').click();
    await page.locator('#importStatus').filter({ hasText: 'Firestore 회차 저장에 실패' }).waitFor();
    await page.locator('#importSaveBtn').click();
    await page.locator('#importStatus').filter({ hasText: '회차를 생성했습니다' }).waitFor();
    const saved = await page.evaluate(() => window.__testFirebase);
    assert.equal(Object.keys(saved.docs).length, 1);
    assert.equal(saved.uploads.length, 1);
    assert.equal(new Set(saved.attempts).size, 1);
    const round = Object.values(saved.docs)[0];
    assert.equal(round.grade, '중1'); assert.equal(round.questions.length, 20); assert.equal(round.groups.length, 5);
    assert.equal(round.questions[0].rows[0].korean, '교사가 수정한 해석');
    assert.equal(round.visible, false); assert.ok(round.wholeAudioPath.startsWith('teacher-audio/'));
    await page.locator('[data-question-timings]').fill('1번 01:41\n2번 02:28');
    await page.locator('[data-save-question-timings]').click();
    assert.deepEqual(await page.evaluate(() => Object.values(window.__testFirebase.docs)[0].questionTimings), [{ number: 1, start: 101 }, { number: 2, start: 148 }]);
    // Missing translation/audio still allows edited English to reach a preview.
    failPartial = true;
    await page.locator('#importExamBtn').click();
    await page.locator('#importStatus').filter({ hasText: '미리보기 준비 완료' }).waitFor();
    assert.equal(await page.locator('#importQuestions .preview-q').count(), 20);
    assert.equal(await page.locator('#importWarnings li').count(), 2);
    assert.equal(await page.locator('#importSaveBtn').isEnabled(), true);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    if (process.env.UI_SCREENSHOT) await page.screenshot({ path: process.env.UI_SCREENSHOT, fullPage: true });
    await page.locator('#importClearBtn').click();
    await page.locator('[data-toggle-round]').click();
    const studentSeed = await page.evaluate(() => window.__testFirebase);
    await page.addInitScript(seed => { window.__testFirebase = seed; }, studentSeed);
    await page.goto(`${origin}/index.html`);
    await page.locator('#studentNo').fill('10101'); await page.locator('#studentName').fill('검증 학생');
    await page.locator('#loginForm button').click();
    await page.locator('#studentView').waitFor({ state: 'visible' });
    await page.locator('#gradeSelect').selectOption('중1');
    await page.locator('#roundSelect option').filter({ hasText: '교사 확인 테스트' }).waitFor({ state: 'attached' });
    await page.locator('#roundSelect').selectOption(Object.keys(studentSeed.docs)[0]);
    await page.locator('[data-group="0"]').click();
    assert.equal(await page.locator('#groupButtons button').count(), 5);
    assert.equal(await page.locator('#scriptText .question-script').count(), 4);
    assert.ok((await page.locator('#scriptText').textContent()).includes('교사가 수정한 해석'));
    assert.equal(await page.locator('#readSteps .listen').count(), 3);
    assert.equal(await page.locator('#readSteps .record').count(), 3);
    try { await page.waitForFunction(() => Math.abs(document.getElementById('practiceAudio').currentTime - 101) < 1, null, { timeout: 5000 }); }
    catch (error) { console.log(await page.locator('#practiceAudio').evaluate(audio => ({ src: audio.src, duration: audio.duration, currentTime: audio.currentTime, readyState: audio.readyState, error: audio.error?.message, rounds: window.__testFirebase.docs }))); throw error; }
    await page.locator('#playPause').click();
    await page.waitForFunction(() => !document.getElementById('practiceAudio').paused);
    // Trigger completion events to check the existing transaction/progress transitions
    // without making this integration check wait for three full 16-minute plays.
    for (let attempt = 1; attempt <= 3; attempt++) {
      await page.locator('#practiceAudio').evaluate(audio => audio.dispatchEvent(new Event('ended')));
      await page.waitForFunction(n => Object.values(window.__testFirebase.progress)[0]?.listenCount === n, attempt);
    }
    await page.locator('#recordInfo').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#readModePill').textContent(), '녹음 0/3');
    assert.equal(await page.evaluate(() => Object.keys(window.__testFirebase.activityLogs).length), 3);
    assert.deepEqual(errors, []);
    console.log(`Browser import passed: real 20-question PDF, ${duration.toFixed(1)}s MP3, editable preview, no writes before confirmation, upload/write retries without duplicates, manual timings, partial failures, mobile layout, student grade/round/groups and MP3 playback, 3-listen progress to 3-record mode.`);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
