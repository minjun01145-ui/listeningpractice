import { prepareExam, publicPreview, downloadExamAudio, translateExam } from '../import-service.js';
import { download } from '../download.js';
import { extractPdfText, parseOfficialScript, scriptPdfFromZip } from '../pdf-script.js';

const [year = '2025', grade = '중1', session = '1'] = process.argv.slice(2);
const exam = await prepareExam({ year: Number(year), grade, ...(grade === '고1' ? { month: Number(session) } : { session: Number(session) }) });
const audio = await downloadExamAudio(exam);
const preview = publicPreview(exam);
const expected = grade === '고1' ? 17 : 20;
if (preview.questions.length !== expected) throw new Error(`Expected ${expected} questions, got ${preview.questions.length}`);
if (preview.questions.some(q => !q.rows.length)) throw new Error('Empty question');
console.log(JSON.stringify({ title: preview.title, questionCount: preview.questions.length,
  rowCount: preview.questions.reduce((n, q) => n + q.rows.length, 0),
  audioBytes: audio.length, sources: preview.sources, warnings: preview.warnings }, null, 2));
if (exam.scriptSource?.zipUrl) {
  const zip = await download(exam.scriptSource.zipUrl);
  const questions = parseOfficialScript(await extractPdfText(scriptPdfFromZip(zip.bytes)));
  if (questions.length !== preview.questions.length) throw new Error('ZIP script does not match PDF question count');
  console.log('Official ZIP script fallback passed.');
}
if (process.env.LIVE_TRANSLATION === 'true') {
  const result = await translateExam(exam);
  if (result.warnings.length || result.questions.some(q => q.rows.some(row => !row.korean))) {
    throw new Error(`Live translation failed: ${result.warnings.join(' ')}`);
  }
  console.log('Live Korean translation passed.');
}
