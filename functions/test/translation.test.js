import test from 'node:test';
import assert from 'node:assert/strict';
import { translateExamWithOllama } from '../translation-service.js';

const fixture = () => ({ selection: { grade: '고1' }, questions: [
  { number: 1, rows: [{ english: 'M: I cannot go today.', korean: '' }, { english: 'W: Can you come tomorrow?', korean: '' }, { english: 'M: _________', korean: '' }] },
  { number: 2, rows: [{ english: 'W: Thanks for your help.', korean: '' }] },
] });
const response = translations => ({ ok: true, json: async () => ({ done: true, message: { content: JSON.stringify({ translations }) } }) });

test('AI translation gets official question context, matches row ids and preserves blank answers', async () => {
  const exam = fixture(), original = structuredClone(exam);
  exam.translation = { questions: [], translationProvider: 'Google cached' };
  const result = await translateExamWithOllama(exam, { apiKey: 'isolated-key', model: 'deepseek-v4.1-flash:cloud', numbers: [1], questions: [{ english: 'Forged client script' }] }, async (url, options) => {
    assert.equal(url, 'https://ollama.com/api/chat');
    assert.equal(options.headers.Authorization, 'Bearer isolated-key');
    const payload = JSON.parse(options.body);
    assert.equal(payload.model, 'deepseek-v4.1-flash');
    assert.equal(payload.think, false);
    const context = JSON.parse(payload.messages[1].content);
    assert.equal(context.grade, '고1');
    assert.deepEqual(context.questions[0].rows, [{ id: '1:0', english: 'M: I cannot go today.' }, { id: '1:1', english: 'W: Can you come tomorrow?' }]);
    return response([{ id: '1:1', korean: 'W: 내일 올 수 있어?' }, { id: '1:0', korean: 'M: 오늘은 갈 수 없어.' }]);
  });
  assert.equal(result.questions[0].rows[0].korean, 'M: 오늘은 갈 수 없어.');
  assert.equal(result.questions[0].rows[1].korean, 'W: 내일 올 수 있어?');
  assert.equal(result.questions[0].rows[2].korean, 'M: _________');
  assert.deepEqual(exam.questions, original.questions);
  assert.equal(exam.translation.translationProvider, 'Google cached');
  assert.equal(JSON.stringify(result).includes('isolated-key'), false);
});

test('AI results never reuse another credential or shared exam translation cache', async () => {
  const exam = fixture();
  const translate = async apiKey => translateExamWithOllama(exam, { apiKey, numbers: [2] }, async (_url, options) => response([{ id: '2:0', korean: options.headers.Authorization.endsWith('first') ? 'W: 도와줘서 고마워.' : 'W: 도와주셔서 감사합니다.' }]));
  assert.equal((await translate('first')).questions[0].rows[0].korean, 'W: 도와줘서 고마워.');
  assert.equal((await translate('second')).questions[0].rows[0].korean, 'W: 도와주셔서 감사합니다.');
  assert.equal(exam.translation, undefined);
});

test('missing, duplicate, unknown and non-Korean row responses fail without altering English', async () => {
  const exam = fixture();
  for (const values of [[], [{ id: '1:0', korean: '해석' }, { id: '1:0', korean: '중복' }], [{ id: '1:0', korean: '해석' }, { id: '2:0', korean: '다른 문항' }], [{ id: '1:0', korean: 'English' }, { id: '1:1', korean: '해석' }], [{ id: '1:0', korean: '번호\n2번' }, { id: '1:1', korean: '해석' }]]) {
    await assert.rejects(translateExamWithOllama(exam, { apiKey: 'test', numbers: [1] }, async () => response(values)), /AI 번역/);
  }
  assert.deepEqual(exam, fixture());
});

test('selection and authentication failures are clear and credentials are absent from errors', async () => {
  for (const numbers of [[], [1, 1], [99], [1, 2, 3, 4]]) await assert.rejects(translateExamWithOllama(fixture(), { apiKey: 'test', numbers }), /번역할 문항/);
  await assert.rejects(translateExamWithOllama(fixture(), { numbers: [1] }), /API 키/);
  await assert.rejects(translateExamWithOllama(fixture(), { apiKey: 'secret-test', numbers: [1] }, async () => ({ ok: false, status: 401 })), /Ollama 인증/);
});
