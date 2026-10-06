import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { parseOfficialScript, scriptPdfFromZip } from '../pdf-script.js';
import { discover, ebsRecord, validateSelection, matchesExamTitle, jejuAttachments } from '../sources.js';
import { officialUrl } from '../download.js';
import { translateExam, publicPreview } from '../import-service.js';
import { handlePastExam } from '../index.js';

test('exact official selection and trusted download URLs only', () => {
  assert.throws(() => validateSelection({ year: 2025, grade: '고1', session: 1 }));
  assert.throws(() => validateSelection({ year: 2025, grade: '중1', session: '1' }));
  for (const url of ['https://127.0.0.1/a', 'https://cbox.ebs.co.kr.evil.com/a', 'http://cbox.ebs.co.kr/a', 'https://user@cbox.ebs.co.kr/a']) assert.throws(() => officialUrl(url));
  assert.equal(officialUrl('/portal/test.pdf'), 'https://cbox.ebs.co.kr/portal/test.pdf');
  assert.equal(ebsRecord({ list: [{ year: 2024, round: '1회' }] }, { year: 2025, grade: '중1', session: 1 }), null);
  const record = ebsRecord({ list: [{ year: 2025, round: '1회', urlScrpt: '/a.pdf' }] }, { year: 2025, grade: '중1', session: 1 });
  assert.equal(record.scriptUrl, 'https://cbox.ebs.co.kr/a.pdf');
  assert.equal(matchesExamTitle('2025 제1회 영어듣기능력평가 중2', { year: 2025, grade: '중1', session: 1 }), false);
});

test('adapter failure falls back; absence clearly fails', async () => {
  const source = { scriptUrl: 'https://cbox.ebs.co.kr/a.pdf', audioUrl: 'https://midwstr.ebs.co.kr/a.mp3' };
  const result = await discover({}, [async () => { throw new Error('changed HTML'); }, async () => source]);
  assert.equal(result.candidates[0], source); assert.equal(result.warnings.length, 1);
  await assert.rejects(discover({}, [async () => null]), /자료를 자동으로 찾지 못했습니다/);
});

test('education office attachments exclude answers and explanation audio', () => {
  const result = jejuAttachments('<a href="/board/download.jje?id=1">대본.pdf</a><a href="/board/download.jje?id=2">정답.pdf</a><a href="/board/download.jje?id=3">전국중1.mp3</a><a href="/board/download.jje?id=4">해설.mp3</a>', 'https://www.jje.go.kr/board/view.jje');
  assert.equal(result.scriptUrl, 'https://www.jje.go.kr/board/download.jje?id=1');
  assert.equal(result.audioUrl, 'https://www.jje.go.kr/board/download.jje?id=3');
});

test('PDF parsing joins wraps, keeps missing-answer lines and text after pause, omits Korean headers', () => {
  const questions = parseOfficialScript('2025 대본\n1번 다음을 듣고 고르시오.\nM: My name is\nChris.\nW: Hello.\n[ Pause] Good morning.\n2번\nW: See you.\nM: __________\nANN: 수고하셨습니다.');
  assert.equal(questions.length, 2);
  assert.equal(questions[0].rows[0].english, 'M: My name is Chris.');
  assert.equal(questions[0].rows[1].english, 'W: Hello. Good morning.');
  assert.equal(questions[1].rows[1].english, 'M: __________');
  assert.throws(() => parseOfficialScript('1번\n2번\nW: Hi!'), /문항 구분/);
  assert.throws(() => parseOfficialScript('1번\nW: Hi!\n1번\nM: Hello.'), /문항 구분/);
  assert.throws(() => parseOfficialScript('a scanned PDF with no markers'), /문항 구분/);
});

test('ZIP only extracts script PDFs; bad ZIPs and missing scripts fail', () => {
  const bytes = zipSync({ 'script.pdf': strToU8('%PDF-test'), 'answer.pdf': strToU8('answer') });
  assert.equal(Buffer.from(scriptPdfFromZip(bytes)).toString(), '%PDF-test');
  const legacy = zipSync({ '2025_´ëº»_Áß1.pdf': strToU8('%PDF-legacy') });
  assert.equal(Buffer.from(scriptPdfFromZip(legacy)).toString(), '%PDF-legacy');
  assert.throws(() => scriptPdfFromZip(zipSync({ 'answer.pdf': strToU8('answer') })));
  assert.throws(() => scriptPdfFromZip(strToU8('not a zip')));
});

test('translation gets only real English, validates count and preserves partial results', async () => {
  const english = Array.from({ length: 101 }, (_, i) => ({ english: `Line ${i}`, korean: '' }));
  const exam = { questions: [{ number: 1, rows: english }] };
  let count = 0;
  const result = await translateExam(exam, async texts => {
    assert.deepEqual(texts, count ? ['Line 100'] : english.slice(0, 100).map(row => row.english));
    if (count++) throw new Error('quota');
    return texts.map(() => '해석 &amp; 확인');
  });
  assert.equal(result.questions[0].rows[0].korean, '해석 & 확인');
  assert.equal(result.questions[0].rows[100].korean, '');
  assert.equal(result.warnings.length, 1); assert.equal(exam.questions[0].rows[0].korean, '');
  const failed = await translateExam({ questions: [{ number: 1, rows: [{ english: 'Hi', korean: '' }] }] }, async () => []);
  assert.equal(failed.questions[0].rows[0].english, 'Hi'); assert.equal(failed.warnings.length, 1);
});

test('preview contains sources and no persistent database writes', () => {
  const source = { pageUrl: 'https://mid.ebs.co.kr/english/engGrade', audioUrl: 'https://midwstr.ebs.co.kr/a.mp3' };
  const result = publicPreview({ selection: { grade: '중1' }, title: 'test', questions: [], sources: [source], scriptSource: null, audioSource: source, warnings: [], rawText: '' });
  assert.equal(result.sources.length, 1); assert.equal(result.hasAudio, true);
});

test('HTTP validates method, content type and operation before discovery', async () => {
  const res = { set() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await handlePastExam({ method: 'GET' }, res); assert.equal(res.code, 405);
  await handlePastExam({ method: 'POST', is: () => false }, res); assert.equal(res.code, 415);
  await handlePastExam({ method: 'POST', is: () => true, path: '/unknown' }, res); assert.equal(res.code, 404);
});
