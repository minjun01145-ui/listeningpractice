// Transformers.js 3.8.1 grows and copies the entire model buffer on each
// streamed chunk if Content-Length is missing. Gather once, then supply its
// actual byte length so both downloads and old cached responses load linearly.
export async function sizedModelResponse(response, onProgress = () => {}, limit = 192 * 1024 * 1024) {
  if (!response.ok || response.headers.has('content-length') || !response.body) return response;
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('음성인식 모델 파일의 허용 크기를 초과했습니다.');
      chunks.push(value); onProgress(size);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const headers = new Headers(response.headers); headers.set('Content-Length', String(size));
  return new Response(bytes, { status: response.status, statusText: response.statusText, headers });
}
