import test from 'node:test';
import assert from 'node:assert/strict';
import { translateQuestion } from '../translation-service.js';

const rows = ['M: I cannot go today.', 'W: Can you come tomorrow?', 'M: _________'];
const reply = translations => ({ ok: true, status: 200, json: async () => ({ done: true, message: { content: JSON.stringify({ translations }) } }) });

test('one question per request with flat row ids, schema output and blank answers kept', async () => {
  const result = await translateQuestion({ apiKey: 'isolated-key', model: 'deepseek-v4.1-flash:cloud', grade: '고1', number: 1, rows }, async (url, options) => {
    assert.equal(url, 'https://ollama.com/api/chat');
    assert.equal(options.headers.Authorization, 'Bearer isolated-key');
    const payload = JSON.parse(options.body);
    assert.equal(payload.model, 'deepseek-v4.1-flash');
    assert.equal(payload.format.properties.translations.type, 'array');
    const context = JSON.parse(payload.messages[1].content);
    assert.equal(context.grade, '고1');
    assert.deepEqual(context.rows, [{ id: '1', english: rows[0] }, { id: '2', english: rows[1] }]);
    return reply([{ id: '2', korean: 'W: 내일\n올 수 있어?' }, { id: '1', korean: '오늘은 갈 수 없어.' }]);
  });
  assert.deepEqual(result.korean, ['M: 오늘은 갈 수 없어.', 'W: 내일 올 수 있어?', 'M: _________']);
  assert.equal(result.missing, 0);
  assert.equal(JSON.stringify(result).includes('isolated-key'), false);
});

test('rows the model skipped or answered in English are asked again, then reported', async () => {
  let calls = 0;
  const result = await translateQuestion({ apiKey: 'k', number: 2, rows }, async (_url, options) => {
    calls++;
    const context = JSON.parse(JSON.parse(options.body).messages[1].content);
    if (calls === 1) return reply([{ id: '1', korean: 'M: 오늘은 갈 수 없어.' }, { id: '2', korean: 'Can you come tomorrow?' }]);
    assert.deepEqual(context.rows.map(row => row.id), ['2']); assert.equal(context.script.length, 3);
    return reply([]);
  });
  assert.equal(calls, 2);
  assert.deepEqual(result.korean, ['M: 오늘은 갈 수 없어.', '', 'M: _________']);
  assert.equal(result.missing, 1);
});

test('input, authentication and empty results fail clearly without the key', async () => {
  for (const input of [{ number: 0, rows }, { number: 1, rows: [] }, { number: 1, rows: ['x'.repeat(3001)] }]) await assert.rejects(translateQuestion({ apiKey: 'k', ...input }), /문항|대본/);
  await assert.rejects(translateQuestion({ number: 1, rows }), /API 키/);
  await assert.rejects(translateQuestion({ apiKey: 'secret-test', number: 1, rows }, async () => ({ ok: false, status: 401 })), /Ollama 인증/);
  await assert.rejects(translateQuestion({ apiKey: 'k', number: 3, rows: rows.slice(0, 2) }, async () => reply([])), /3번/);
});
