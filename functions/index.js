import { onRequest } from 'firebase-functions/v2/https';
import { prepareExam, publicPreview, translateExam, downloadExamAudio } from './import-service.js';

export async function handlePastExam(req, res) {
  res.set('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST 요청만 지원합니다.' });
  if (!req.is('application/json')) return res.status(415).json({ error: 'JSON 형식으로 요청하세요.' });
  const action = req.path.split('/').filter(Boolean).at(-1);
  if (!['prepare', 'translate', 'audio'].includes(action)) return res.status(404).json({ error: '지원하지 않는 가져오기 단계입니다.' });
  try {
    const exam = await prepareExam(req.body);
    if (action === 'prepare') return res.json(publicPreview(exam));
    if (action === 'translate') return res.json(await translateExam(exam));
    const bytes = await downloadExamAudio(exam);
    res.set('Content-Type', 'audio/mpeg');
    // Streaming avoids the non-streaming Cloud Functions response size limit.
    for (let start = 0; start < bytes.length; start += 1024 * 1024) res.write(bytes.subarray(start, start + 1024 * 1024));
    return res.end();
  } catch (error) {
    console.warn('Past exam import failed:', error.message);
    return res.status(422).json({ error: error.message || '자료를 자동으로 준비하지 못했습니다. 수동 등록을 이용하세요.' });
  }
}

export const pastExamImport = onRequest({
  region: 'asia-northeast3', memory: '512MiB', timeoutSeconds: 120,
  maxInstances: 2, concurrency: 1,
}, handlePastExam);
