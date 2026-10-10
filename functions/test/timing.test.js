import test from 'node:test';
import assert from 'node:assert/strict';
import { highSchoolRecord, validateSelection } from '../sources.js';
import { parseHighSchoolScript } from '../pdf-script.js';
import { validateOllama, checkOllama, ollamaChat } from '../ollama.js';
import { alignQuestions, cueNumber, findCue, findInstruction, cueWindows, questionStart, buildTimings, chunkPlan, energyProfile, speechOnsets } from '../../timing-match.js';
import { parseTimingText, timingsMarkdown, validateTimings } from '../../audio-timing.js';

const questions = [
  { number: 1, rows: [{ english: 'M: Good morning students, this is your principal speaking today.' }, { english: 'W: Thank you.' }] },
  { number: 2, rows: [{ english: 'W: Hello David, would you like to join our new music club?' }, { english: 'M: Sure, I love music.' }] },
  { number: 3, rows: [{ english: 'M: Excuse me, where is the nearest subway station from here?' }] },
];
// Whisper-style segments: intro, "1." cue, dialogue, jingle, Korean-ish lines, …
const segments = () => [
  { start: 0, end: 20, text: '[music]' },
  { start: 50, end: 51, text: '1.' },
  { start: 56, end: 60, text: 'Good morning students, this is your principal speaking today.' },
  { start: 60, end: 61, text: 'Thank you.' },
  { start: 70, end: 80, text: '[music]' },
  { start: 92, end: 96, text: 'Hello, David. Would you like to join our new music club?' },
  { start: 96, end: 98, text: 'Sure, I love music.' },
  { start: 120, end: 121, text: '3rd.' },
  { start: 130, end: 135, text: 'Excuse me, where is the nearest subway station from here?' },
];

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

test('Ollama uses fixed cloud endpoint, transient bearer key, real model id and a JSON schema', async () => {
  const result = await checkOllama({ apiKey: 'test-key', model: 'deepseek-v4.1-flash:cloud' }, async (url, options) => {
    assert.equal(url, 'https://ollama.com/api/chat'); assert.equal(options.headers.Authorization, 'Bearer test-key');
    const body = JSON.parse(options.body); assert.equal(body.model, 'deepseek-v4.1-flash'); assert.equal(body.stream, false);
    assert.equal(body.format.type, 'object');
    return { ok: true, status: 200, json: async () => ({ message: { content: '{"connected":true}' } }) };
  });
  assert.equal(result.connected, true); assert.ok(!JSON.stringify(result).includes('test-key'));
  assert.throws(() => validateOllama({ apiKey: 'key\nHeader', model: 'm' }));
  await assert.rejects(checkOllama({ apiKey: 'secret' }, async () => ({ ok: false, status: 403 })), /인증/);
});

test('Ollama retries busy and malformed replies once, and accepts fenced JSON', async () => {
  let calls = 0;
  const replies = [{ ok: false, status: 429 }, { ok: true, status: 200, json: async () => ({ message: { content: '```json\n{"ok":1}\n```' } }) }];
  const { result } = await ollamaChat({ apiKey: 'k' }, [], {}, async () => replies[calls++]);
  assert.deepEqual(result, { ok: 1 }); assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(ollamaChat({ apiKey: 'k' }, [], {}, async () => { calls++; return { ok: true, status: 200, json: async () => ({ message: { content: '{"a":1}]},{' } }) }; }), /JSON/);
  assert.equal(calls, 2);
});

test('cue parser reads Whisper renderings of "N번" but not dialogue numbers', () => {
  for (const [text, number] of [['5.', 5], ['14th.', 14], ['17.', 17], ['7번.', 7], ['칠 번', 7], ['십오 번', 15], ['Number five.', 5], ['3. Next,', 3], ['12번 대화를 듣고', 12], ['19번과 20번]', 19]]) assert.equal(cueNumber(text), number, text);
  for (const text of ['6 p.m. sounds good.', '10 dollars, please.', 'Hello.', 'One day, baking class']) assert.equal(cueNumber(text), null, text);
});

test('alignment finds each dialogue in order and is not derailed by a missing one', () => {
  const alignment = alignQuestions(questions, segments());
  assert.deepEqual(alignment.map(item => item.englishStart), [56, 92, 130]);
  // Whisper dropped question 2 entirely: 1 and 3 still align, 2 is left empty.
  const partial = alignQuestions(questions, segments().filter(segment => segment.start < 90 || segment.start > 100));
  assert.deepEqual(partial.map(item => item.englishStart), [56, null, 130]);
  // A short trailing line ("Thank you.") never becomes the next question's start.
  assert.notEqual(alignment[1].englishStart, 60);
});

test('a repeated passage starts at its first play and shared questions copy it', () => {
  const shared = [...questions, { number: 4, rows: structuredClone(questions[2].rows) }];
  const list = [...segments(), { start: 200, end: 205, text: 'Excuse me, where is the nearest subway station from here?' }];
  const alignment = alignQuestions(shared, list);
  assert.equal(alignment[2].englishStart, 130);
  assert.equal(alignment[3].sharedWith, 3); assert.equal(alignment[3].englishStart, 130);
});

test('cue search prefers a group header and never uses the opening announcement', () => {
  const korean = [{ start: 10, end: 14, text: '1번부터 17번까지는 한 번만 들려줍니다' }, { start: 50, end: 51, text: '1번' }, { start: 52, end: 56, text: '다음을 듣고 고르시오' }];
  assert.equal(findCue(korean, 1, 0, 60), 50);
  const group = [{ start: 100, end: 103, text: '19번과 20번] 대화를 듣고' }, { start: 108, end: 109, text: '19번' }];
  assert.equal(findCue(group, 19, 95, 115), 100);
  assert.equal(findInstruction([{ start: 10, end: 14, text: '잘 듣고 답하시기 바랍니다' }, { start: 49, end: 50, text: '칠 번' }, { start: 50.5, end: 55, text: '대화를 듣고 고르시오' }], 0, 60), 49);
});

test('Korean windows start after the longest pause or jingle, not in silence', () => {
  const alignment = alignQuestions(questions, segments());
  const onsets = [{ time: 50, gap: 9 }, { time: 62, gap: 0.4 }, { time: 84, gap: 1.6 }, { time: 86, gap: 0.5 }];
  const [first] = cueWindows(alignment, 1, segments(), onsets, 200);
  assert.ok(Math.abs(first.start - 83.7) < 0.01 && first.end === 93, JSON.stringify(first));
  assert.equal(questionStart(51.5, onsets), 50);
  assert.equal(questionStart(86.2, onsets), 84);
});

test('timings use heard cues, fall back to the dialogue and leave unknown questions empty', () => {
  const shared = [...questions, { number: 4, rows: structuredClone(questions[2].rows) }];
  const alignment = alignQuestions(shared, segments());
  const result = buildTimings(shared, alignment, [{ time: 50 }, null, { time: 120 }, null]);
  assert.deepEqual(result.timings.map(t => [t.number, t.start]), [[1, 49.7], [2, 91.7], [3, 119.7], [4, 119.7]]);
  assert.ok(result.warnings.some(text => /2번.*안내를 찾지 못해/.test(text)));
  const english = buildTimings(shared, alignment, [{ time: 50 }, null, { time: 120 }, null], false);
  assert.deepEqual(english.timings.map(t => t.start), [55.7, 91.7, 129.7, 129.7]);
  const missing = buildTimings(questions, alignQuestions(questions, segments().slice(0, 4)), [{ time: 50 }, null, null]);
  assert.deepEqual(missing.missing, [2, 3]);
});

test('chunks are cut at the quietest point and onsets carry pause length', () => {
  const samples = new Float32Array(16000 * 70).map((_, i) => (Math.floor(i / 16000) % 8 === 7 ? 0 : Math.sin(i / 5) * 0.3));
  const profile = energyProfile(samples), chunks = chunkPlan(profile);
  assert.equal(chunks[0].start, 0); assert.ok(chunks.every(chunk => chunk.end - chunk.start <= 29.5));
  assert.equal(chunks.at(-1).end, 70);
  for (const chunk of chunks.slice(0, -1)) assert.ok(chunk.end % 8 > 7 && chunk.end % 8 < 8, String(chunk.end));
  assert.ok(speechOnsets(profile).some(onset => Math.abs(onset.time - 8) < 0.1 && onset.gap > 0.9));
});

test('manual table round-trips and does not allow unrelated equal starts', () => {
  const shared = [...questions, { number: 4, rows: structuredClone(questions[2].rows) }];
  const timings = [{ number: 1, start: 56 }, { number: 2, start: 101 }, { number: 3, start: 130 }, { number: 4, start: 130 }];
  const parsed = parseTimingText(timingsMarkdown(timings));
  assert.deepEqual(parsed, timings);
  assert.doesNotThrow(() => validateTimings(parsed, shared));
  assert.throws(() => validateTimings([{ number: 1, start: 56 }, { number: 2, start: 56 }], shared));
});
