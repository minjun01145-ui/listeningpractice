import { discover, GRADES, sourceProviders, validateSelection } from './sources.js';
import { download } from './download.js';
import { extractPdfText, parseOfficialScript, scriptPdfFromZip } from './pdf-script.js';
import { GoogleAuth } from 'google-auth-library';

const cache = new Map();
const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-translation'] });
const TTL = 30 * 60 * 1000;

async function readScript(source) {
  if (source.scriptUrl) {
    try { return await extractPdfText((await download(source.scriptUrl)).bytes); }
    catch { /* Some official sites only provide a working ZIP. */ }
  }
  if (source.zipUrl) {
    return extractPdfText(scriptPdfFromZip((await download(source.zipUrl)).bytes));
  }
  throw new Error('대본 PDF·ZIP 다운로드 또는 PDF 분석에 실패했습니다. 출처에서 대본을 내려받아 수동 입력하세요.');
}

export async function prepareExam(input) {
  const selection = validateSelection(input), key = JSON.stringify(selection);
  const previous = cache.get(key);
  if (previous && previous.expires > Date.now()) return previous.promise;
  // A small bounded memory cache also coalesces repeated requests on one instance.
  if (cache.size >= 30) cache.delete(cache.keys().next().value);
  const promise = collectExam(selection);
  cache.set(key, { promise, expires: Date.now() + TTL });
  try { return await promise; } catch (error) { cache.delete(key); throw error; }
}

async function collectExam(selection) {
  const found = await discover(selection), warnings = [...found.warnings];
  let questions = [], rawText = '', scriptSource = null, audioSource = null;
  async function consume(candidates) {
    for (const source of candidates) {
      if (!audioSource && source.audioUrl) audioSource = source;
      if (!questions.length && (source.scriptUrl || source.zipUrl)) {
        try {
          const text = await readScript(source);
          rawText = text;
          questions = parseOfficialScript(text, GRADES[selection.grade].expectedCount);
          scriptSource = source;
        } catch (error) { warnings.push(error.message); }
      }
    }
  }
  await consume(found.candidates);
  // If the first provider's PDF format changed, still try the independent provider.
  if (!questions.length && found.candidates.length === 1 && found.candidates[0].name.startsWith('EBS')) {
    try { const fallback = await discover(selection, sourceProviders.slice(1)); await consume(fallback.candidates); }
    catch { warnings.push('교육청 대체 자료에서도 대본을 확인하지 못했습니다.'); }
  }
  if (!questions.length && !audioSource) throw new Error('대본과 전체 음원을 준비하지 못했습니다. 출처 자료를 확인하고 수동 등록을 이용하세요.');
  if (questions.length && questions.length !== GRADES[selection.grade].expectedCount) warnings.push(`${questions.length}문항을 인식했습니다. 일반적인 20문항과 다르므로 원본과 비교하세요.`);
  if (!audioSource) warnings.push('대본은 가져왔지만 전체 음원을 찾지 못했습니다. 미리보기에서 음원 파일을 직접 선택할 수 있습니다.');
  if (!questions.length) warnings.push('전체 음원은 발견했지만 대본 분석에 실패했습니다. 원본을 확인하고 미리보기 대본을 직접 입력하세요.');
  return { selection, title: `${selection.year}년 ${selection.grade} 영어듣기평가 제${selection.session}회`, questions, rawText, scriptSource, audioSource, sources: found.candidates, warnings };
}

export function publicPreview(exam) {
  const sources = [...new Map([...exam.sources, exam.scriptSource, exam.audioSource].filter(Boolean).map(source => [source.pageUrl, source])).values()];
  return { title: exam.title, grade: exam.selection.grade, questions: exam.questions, rawText: exam.rawText, sources, warnings: exam.warnings, hasAudio: Boolean(exam.audioSource) };
}

function decodeText(text) {
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity) => {
    if (entity.startsWith('#x')) return String.fromCodePoint(parseInt(entity.slice(2), 16));
    if (entity.startsWith('#')) return String.fromCodePoint(Number(entity.slice(1)));
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[entity] || match;
  });
}

// The client supplies only exam selectors. Translation receives downloaded English only.
export async function translateExam(exam, translateBatch = cloudTranslate) {
  if (exam.translation) return exam.translation;
  if (exam.translationPending) return exam.translationPending;
  exam.translationPending = (async () => {
    const questions = structuredClone(exam.questions), rows = questions.flatMap(q => q.rows), warnings = [];
    for (let start = 0; start < rows.length; start += 100) {
      const batch = rows.slice(start, start + 100);
      try {
        const result = await translateBatch(batch.map(row => row.english));
        if (!Array.isArray(result) || result.length !== batch.length || result.some(text => typeof text !== 'string' || !text.trim())) throw new Error('번역 응답 누락');
        result.forEach((text, index) => { batch[index].korean = decodeText(text); });
      } catch {
        warnings.push('한국어 자동 번역에 실패했습니다. Cloud Translation API와 실행 서비스 계정 권한을 확인하세요. 영어 대본과 음원은 유지되며 해석을 직접 입력할 수 있습니다.');
      }
    }
    const result = { questions, warnings: [...new Set(warnings)], translationProvider: 'Google Cloud Translation (NMT)' };
    if (!warnings.length) exam.translation = result;
    return result;
  })();
  try { return await exam.translationPending; } finally { delete exam.translationPending; }
}

async function cloudTranslate(texts) {
  if (process.env.TRANSLATION_ENABLED === 'false') throw new Error('번역 비활성화');
  const client = await auth.getClient();
  const projectId = process.env.TRANSLATION_PROJECT_ID || await auth.getProjectId();
  const { data } = await client.request({
    url: 'https://translation.googleapis.com/language/translate/v2', method: 'POST', timeout: 20000,
    headers: { 'x-goog-user-project': projectId },
    data: { q: texts, source: 'en', target: 'ko', format: 'text', model: 'nmt' },
  });
  return data.data?.translations?.map(item => item.translatedText);
}

export async function downloadExamAudio(exam) {
  if (!exam.audioSource) throw new Error('전체 음원을 찾지 못했습니다. 음원 파일을 직접 선택하세요.');
  const result = await download(exam.audioSource.audioUrl, { limit: 99 * 1024 * 1024, timeout: 40000 });
  const bytes = result.bytes;
  if (bytes.length < 1024 || !(bytes.subarray(0, 3).toString() === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0))) {
    throw new Error('다운로드된 자료가 MP3 음원이 아닙니다. 출처의 파일을 확인하세요.');
  }
  return bytes;
}
