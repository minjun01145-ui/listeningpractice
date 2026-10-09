// Optional real browser smoke check: official audio and the deployed Whisper worker.
// Downloads the model, but never sends audio to an API or writes production data.
const { createServer } = require('node:http');
const { readFile, writeFile, mkdir } = require('node:fs/promises');
const { resolve } = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
(async () => {
  const { dedupeWords } = await import('../../audio-timing.js');
  const { prepareExam, downloadExamAudio } = await import('../import-service.js');
  const { analyzeTimings, scanTimings } = await import('../timing-service.js');
  const grade = process.env.SPEECH_GRADE || '중1', full = process.env.FULL_SPEECH === 'true';
  const exam = await prepareExam({ year: 2025, grade, ...(grade === '고1' ? { month: 3 } : { session: 1 }) });
  const audio = await downloadExamAudio(exam);
  const root = resolve(__dirname, '../..');
  const seed = process.env.REUSE_SPEECH === 'true' ? JSON.parse(await readFile(resolve(root, '.tmp/whisper-full.json'), 'utf8')) : null;
  const windows = seed ? scanTimings({ ...seed, words: dedupeWords(seed.words), questions: exam.questions }).windows : null;
  if (windows) console.log('Recognition repair windows:', JSON.stringify(windows));
  const server = createServer(async (req, res) => {
    if (req.url.startsWith('/api/past-exam/')) {
      let body = ''; for await (const chunk of req) body += chunk;
      res.setHeader('Content-Type', 'application/json');
      try { res.end(JSON.stringify(req.url.endsWith('timing-scan') ? scanTimings(JSON.parse(body)) : await analyzeTimings(JSON.parse(body)))); }
      catch(error) { res.writeHead(422).end(JSON.stringify({error:error.message})); }
      return;
    }
    if (req.url === '/audio.mp3') { res.setHeader('Content-Type', 'audio/mpeg'); res.end(audio); return; }
    if (req.url === '/speech-worker.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(await readFile(resolve(root, 'speech-worker.js'))); return; }
    if (req.url === '/audio-timing.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(await readFile(resolve(root, 'audio-timing.js'))); return; }
    res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Whisper smoke check</title><select id="timingSpeechProvider"><option value="local">local</option></select><input id="ollamaApiKey"><input id="ollamaModel" value="deepseek-v4.1-flash"><input id="timingIncludeInstructions" type="checkbox">');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    let lastProgressAt = 0;
    page.on('console', message => { if (!message.text().includes('모델 준비') || Date.now() - lastProgressAt > 5000) { console.log(message.text()); lastProgressAt = Date.now(); } });
    page.on('pageerror', error => console.log(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    if (process.env.CLIENT_SPEECH === 'true') {
      const result = await page.evaluate(async questions => {
        const {analyzeAudioTiming} = await import('/audio-timing.js');
        return analyzeAudioTiming({blob:await (await fetch('/audio.mp3')).blob(),questions,status:text=>console.log(text)});
      }, exam.questions);
      await writeFile(resolve(root, '.tmp/whisper-client-timings.json'), JSON.stringify(result,null,2));
      assert.equal(result.timings.length, grade === '고1' ? 17 : 20);
      console.log(JSON.stringify(result)); return;
    }
    const result = await page.evaluate(async ({full, startAt, seed, windows}) => {
      const buffer = await new OfflineAudioContext(1, 1, 16000).decodeAudioData(await (await fetch('/audio.mp3')).arrayBuffer());
      const worker = new Worker('/speech-worker.js', { type: 'module' }), words = seed?.words || [];
      const plan = windows || Array.from({length: full ? Math.ceil(buffer.duration / 25) : 1}, (_,i) => ({start: full ? i * 25 : startAt, end: Math.min((full ? i * 25 : startAt) + 30, buffer.duration)}));
      for (const {start, end} of plan) {
        const first = Math.floor(start * 16000), samples = new Float32Array(Math.floor(end * 16000) - first);
        for (let c = 0; c < buffer.numberOfChannels; c++) for (let i = 0; i < samples.length; i++) samples[i] += buffer.getChannelData(c)[i + first] / buffer.numberOfChannels;
        const chunk = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { worker.terminate(); reject(new Error('Whisper smoke check timed out')); }, 600000);
        worker.onerror = e => { clearTimeout(timer); worker.terminate(); reject(new Error(e.message)); };
        worker.onmessage = e => { if (e.data.progress) { console.log(e.data.progress); return; } clearTimeout(timer); resolve(e.data); };
        worker.postMessage({ audio: samples, repair: Boolean(windows) }, [samples.buffer]);
        });
        if (chunk.error) { worker.terminate(); return chunk; }
        for (const word of chunk.words) words.push({ ...word, start: word.start + (full ? start : 0), end: word.end + (full ? start : 0) });
        console.log(`Recognized ${Math.floor(end)} / ${Math.floor(buffer.duration)} seconds`);
        if (!full) break;
      }
      worker.terminate(); return { words: words.sort((a,b) => a.start - b.start), duration: full ? buffer.duration : 30 };
    }, {full, startAt: Number(process.env.SPEECH_START || 60), seed, windows});
    if (result.words) result.words = dedupeWords(result.words);
    await mkdir(resolve(root, '.tmp'), { recursive: true });
    await writeFile(resolve(root, full ? '.tmp/whisper-full.json' : '.tmp/whisper-smoke.json'), JSON.stringify(result, null, 2));
    assert.ok(!result.error, result.error);
    assert.ok(result.words.length >= 20, 'Too few actual word timestamps');
    assert.ok(result.words.every(w => w.start >= 0 && w.end >= w.start && w.end <= result.duration));
    if (full) {
      const timings = await analyzeTimings({ ...result, questions: exam.questions, includeInstructions: false });
      await writeFile(resolve(root, '.tmp/whisper-full-timings.json'), JSON.stringify(timings, null, 2));
      assert.equal(timings.timings.length, grade === '고1' ? 17 : 20);
      console.log(JSON.stringify(timings));
    } else console.log(JSON.stringify(result));
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
