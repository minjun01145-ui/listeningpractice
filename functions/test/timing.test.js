import test from 'node:test';
import assert from 'node:assert/strict';
import { highSchoolRecord, validateSelection } from '../sources.js';
import { parseHighSchoolScript } from '../pdf-script.js';
import { validateOllama, checkOllama, recognizeChunk, validateSpeech, timingCandidates, selectTimings, analyzeTimings, scanTimings } from '../timing-service.js';
import { parseTimingText, timingsMarkdown, validateTimings, pcmBase64 } from '../../audio-timing.js';

const questions = [
  { number: 1, rows: [{ english: 'M: Good morning students this is your principal speaking today.' }] },
  { number: 2, rows: [{ english: 'W: Hello David would you like to join our new music club?' }] },
];
function wordFixture() {
  const words = [{ text: '1번', start: 56, end: 57 }];
  for (const [index, question] of questions.entries()) {
    if (index) words.push({ text: '2번', start: 101, end: 102 });
    for (const [i, text] of question.rows[0].english.replace(/^[MW]: /, '').replace(/[.?]/g, '').split(' ').entries()) words.push({ text, start: 65 + index * 45 + i * 0.5, end: 65.4 + index * 45 + i * 0.5 });
  }
  return { questions, words, duration: 160 };
}

test('high school selects precise year/month/grade English downloads', () => {
  const selection = validateSelection({ year: 2025, grade: '고1', month: 3 });
  assert.deepEqual(selection, { year: 2025, grade: '고1', month: 3 });
  assert.throws(() => validateSelection({ year: 2025, grade: '고1', month: 5 }));
  const button = (kind, record, path) => `<button onclick="goDownLoad${kind}('${path}', '/folder', '${record}', '318', '1', '17014', '0')">파일</button>`;
  const html = button('D', '202503261', '/20250326/go1/eng_scr.pdf') + button('R', '202503261', '/20250326/go1/eng_mp3.mp3') + button('D', '202403261', '/20240326/go1/old.pdf') + button('R', '202503263', '/20250326/go3/wrong.mp3');
  const source = highSchoolRecord(html, selection);
  assert.match(source.scriptUrl, /20250326\/go1\/eng_scr.pdf$/); assert.match(source.audioUrl, /go1\/eng_mp3.mp3$/);
  assert.equal(highSchoolRecord(html, { ...selection, month: 6 }), null);
});

test('high school common 16/17 passage survives numbered answer headings', () => {
  const text = Array.from({ length: 15 }, (_, i) => `${i + 1}. 다음을 듣고 고르시오.\nM: A real spoken line for question ${i + 1}.`).join('\n') + '\n16번부터 17번은 두 번 들려줍니다.\n[16 ~ 17] 다음을 듣고 물음에 답하시오.\nW: This is the shared real passage.\n16. 주제로 적절한 것은?\n17. 언급되지 않은 것은?';
  const parsed = parseHighSchoolScript(text);
  assert.equal(parsed.length, 17); assert.equal(parsed[16].sharedWith, 16); assert.deepEqual(parsed[15].rows, parsed[16].rows);
  assert.throws(() => parseHighSchoolScript('1. 다음을 듣고 고르시오.\nM: Incomplete.'), /1~17/);
});

test('Ollama uses fixed cloud endpoint, transient bearer key and real model id', async () => {
  const result = await checkOllama({ apiKey: 'test-key', model: 'deepseek-v4.1-flash:cloud' }, async (url, options) => {
    assert.equal(url, 'https://ollama.com/api/chat'); assert.equal(options.headers.Authorization, 'Bearer test-key');
    const body = JSON.parse(options.body); assert.equal(body.model, 'deepseek-v4.1-flash'); assert.equal(body.stream, false);
    return { ok: true, json: async () => ({ message: { content: '{"connected":true}' } }) };
  });
  assert.equal(result.connected, true); assert.ok(!JSON.stringify(result).includes('test-key'));
  assert.throws(() => validateOllama({ apiKey: 'key\nHeader', model: 'm' }));
  await assert.rejects(checkOllama({ apiKey: 'secret' }, async () => ({ ok: false, status: 403 })), /인증/);
});

test('speech proxy accepts bounded PCM and keeps word offsets in actual audio range', async () => {
  const content = Buffer.alloc(32000).toString('base64'); assert.equal(validateSpeech({ content }).duration, 1);
  assert.throws(() => validateSpeech({ content: Buffer.alloc(46 * 32000).toString('base64') }));
  const result = await recognizeChunk({ content }, async request => {
    assert.equal(request.config.enableWordTimeOffsets, true);
    return { results: [{ alternatives: [{ words: [{ word: 'Hello', startTime: '0.2s', endTime: '0.7s' }, { word: 'Bad', startTime: '-1s', endTime: '10s' }] }] }] };
  });
  assert.deepEqual(result.words, [{ text: 'Hello', start: 0.2, end: 0.7 }]);
});

test('actual transcript matching locates instructions and English starts', async () => {
  const input = wordFixture();
  const result = await analyzeTimings(input);
  assert.deepEqual(result.timings.map(t => t.start), [56, 101]);
  const english = await analyzeTimings({ ...input, includeInstructions: false });
  assert.deepEqual(english.timings.map(t => t.start), [65, 110]);
  const candidates = timingCandidates(input);
  assert.throws(() => selectTimings(candidates, [{ number: 1, candidateId: 'invented' }, { number: 2, candidateId: candidates[1].choices[0].id }], 160), /실제 음원/);
  await assert.rejects(analyzeTimings({ ...input, words: [] }), /시간 정보/);
  await assert.rejects(analyzeTimings({ ...input, duration: 3000 }), /40분/);
});

test('AI selects only observed candidates and never arbitrary guessed times', async () => {
  const input = wordFixture();
  const result = await analyzeTimings({ ...input, apiKey: 'test-key' }, async (_url, options) => {
    const prompt = JSON.parse(JSON.parse(options.body).messages[1].content);
    const selected = prompt.candidates.map(c => ({ number: c.number, candidateId: c.choices[0].id }));
    return { ok: true, json: async () => ({ message: { content: JSON.stringify({ selected }) } }) };
  });
  assert.deepEqual(result.timings.map(t => t.start), [56, 101]); assert.match(result.model, /deepseek/);
});

test('a repeated passage uses the first sufficiently matched play', async () => {
  const input = wordFixture();
  const earlier = input.words.filter(w => w.start >= 65 && w.start < 100).map(w => ({ ...w, text: w.text === 'students' ? 'pupils' : w.text }));
  const repeated = input.words.filter(w => w.start >= 65 && w.start < 100).map(w => ({ ...w, start: w.start + 20, end: w.end + 20 }));
  input.words = [...input.words.filter(w => w.start < 65 || w.start >= 100), ...earlier, ...repeated].sort((a,b) => a.start - b.start);
  const result = await analyzeTimings({ ...input, includeInstructions: false });
  assert.equal(result.timings[0].start, 65);
});

test('missing speech yields bounded recognition retries without invented times', () => {
  const input = wordFixture(); input.words = input.words.filter(w => w.start < 100);
  const scan = scanTimings(input);
  assert.deepEqual(scan.missing, [2]);
  assert.ok(scan.windows.length > 0 && scan.windows.every(w => w.start >= 0 && w.end <= input.duration && w.end-w.start <= 30));
  assert.equal('timings' in scan, false);
});

test('common passage shares audio, manual table round-trips and does not allow unrelated equal starts', async () => {
  const input = wordFixture(); input.questions.push({ number: 3, rows: structuredClone(input.questions[1].rows) });
  const result = await analyzeTimings(input);
  assert.deepEqual(result.timings.map(t => t.start), [56, 101, 101]);
  const table = timingsMarkdown(result.timings), parsed = parseTimingText(table);
  assert.deepEqual(parsed, [{ number: 1, start: 56 }, { number: 2, start: 101 }, { number: 3, start: 101 }]);
  assert.doesNotThrow(() => validateTimings(parsed, input.questions));
  assert.throws(() => validateTimings([{ number: 1, start: 56 }, { number: 2, start: 56 }], input.questions));
});

test('PCM encoder averages channels and handles signed little-endian samples', () => {
  const buffer = { length: 2, numberOfChannels: 2, getChannelData: i => i ? Float32Array.from([1, -1]) : Float32Array.from([1, 1]) };
  const result = Buffer.from(pcmBase64(buffer, 0, 2 / 16000), 'base64');
  assert.equal(result.readInt16LE(0), 32767); assert.equal(result.readInt16LE(2), 0);
});
