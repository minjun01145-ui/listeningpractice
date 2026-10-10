// Real browser check of automatic timing: official exam audio + script, the
// site's own Whisper worker and matcher in installed Chrome. Downloads the model
// on first run; never sends audio to an API or writes production data.
//   node functions/scripts/check-speech.cjs 2025 중1 1
//   node functions/scripts/check-speech.cjs 2025 고1 3
const { createServer } = require('node:http');
const { readFile, writeFile, mkdir } = require('node:fs/promises');
const { resolve, extname } = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
(async () => {
  const [year = '2025', grade = '중1', session = '1'] = process.argv.slice(2);
  const { prepareExam, downloadExamAudio } = await import('../import-service.js');
  const exam = await prepareExam({ year: Number(year), grade, ...(grade === '고1' ? { month: Number(session) } : { session: Number(session) }) });
  const audio = await downloadExamAudio(exam);
  const root = resolve(__dirname, '../..');
  const server = createServer(async (req, res) => {
    const file = new URL(req.url, 'http://localhost').pathname.slice(1);
    if (file === 'audio.mp3') { res.setHeader('Content-Type', 'audio/mpeg'); res.end(audio); return; }
    if (['audio-timing.js', 'timing-match.js', 'speech-worker.js', 'speech-session.js', 'speech-download.js'].includes(file)) {
      res.setHeader('Content-Type', 'text/javascript'); res.end(await readFile(resolve(root, file))); return;
    }
    if (extname(file)) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><title>Timing check</title><input id="timingIncludeInstructions" type="checkbox" checked>');
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    let last = 0;
    page.on('console', message => { if (Date.now() - last > 15000 || !/경과/.test(message.text())) { console.log(message.text()); last = Date.now(); } });
    page.on('pageerror', error => console.log(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const started = Date.now();
    const result = await page.evaluate(async questions => {
      const { analyzeAudioTiming } = await import('/audio-timing.js');
      return analyzeAudioTiming({ blob: await (await fetch('/audio.mp3')).blob(), questions, status: text => console.log(text), debug: true });
    }, exam.questions);
    const seconds = Math.round((Date.now() - started) / 1000);
    await mkdir(resolve(root, '.tmp'), { recursive: true });
    await writeFile(resolve(root, `.tmp/timings-${year}-${grade}-${session}.json`), JSON.stringify(result, null, 2));
    const fmt = s => `${String(Math.floor(s / 60)).padStart(2, '0')}:${(s % 60).toFixed(1).padStart(4, '0')}`;
    console.log(`\n${exam.title} · ${seconds}초 소요`);
    console.log(result.timings.map(t => `${t.number}번 ${fmt(t.start)}`).join('  '));
    for (const warning of result.warnings) console.log(`- ${warning}`);
    const count = grade === '고1' ? 17 : 20;
    assert.equal(result.timings.length + result.missing.length, count);
    assert.ok(result.timings.length >= count - 2, 'Too few timings found');
  } finally { await browser.close(); await new Promise(done => server.close(done)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
