const OLLAMA_URL = 'https://ollama.com/api/chat';
export const DEFAULT_MODEL = 'deepseek-v4.1-flash';

export function validateOllama(input) {
  const apiKey = String(input?.apiKey || '').trim();
  const model = String(input?.model || DEFAULT_MODEL).trim().replace(/:cloud$/, '');
  if (!apiKey || apiKey.length > 1000 || /[\r\n]/.test(apiKey)) throw new Error('교사용 AI 연결 설정에 Ollama API 키를 입력하세요.');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/.test(model)) throw new Error('올바른 Ollama 모델명을 입력하세요.');
  return { apiKey, model };
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// Models sometimes wrap JSON in a code fence even with a schema; accept that.
export function parseJsonContent(content) {
  const text = String(content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(text);
}

// Firebase Hosting cuts proxied requests at 60 seconds, so every call here stays
// below ~55 seconds in total, including one retry for busy/slow/invalid replies.
export async function ollamaChat(input, messages, { format = 'json', maxTokens = 2000, timeoutMs = 25000, attempts = 2 } = {}, fetcher = fetch) {
  const { apiKey, model } = validateOllama(input);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let response;
    try {
      response = await fetcher(OLLAMA_URL, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, stream: false, think: false, format, options: { temperature: 0, num_predict: maxTokens } }),
      });
    } catch {
      lastError = new Error('Ollama 응답 시간이 초과되었습니다. 잠시 후 다시 시도하세요.');
      continue;
    }
    if (response.status === 401 || response.status === 403) throw new Error('Ollama 인증에 실패했습니다. API 키와 모델 사용 권한을 확인하세요.');
    if (response.status === 404) throw new Error(`Ollama Cloud에서 ‘${model}’ 모델을 찾지 못했습니다. 모델명을 확인하세요.`);
    if (!response.ok) {
      lastError = new Error(response.status === 429 ? 'Ollama 동시 요청 한도에 걸렸습니다. 잠시 후 다시 시도하세요.' : `Ollama 요청 실패 (HTTP ${response.status}). 잠시 후 다시 시도하세요.`);
      if (attempt < attempts) await wait(1500 * attempt);
      continue;
    }
    try {
      const data = await response.json();
      if (data.done_reason === 'length') throw new Error('length');
      return { model, result: parseJsonContent(data.message?.content) };
    } catch {
      lastError = new Error('Ollama 응답이 올바른 JSON 형식이 아니었습니다. 다시 시도하세요.');
    }
  }
  throw lastError;
}

export async function checkOllama(input, fetcher) {
  const format = { type: 'object', properties: { connected: { type: 'boolean' } }, required: ['connected'] };
  const response = await ollamaChat(input, [{ role: 'user', content: 'Reply with this JSON: {"connected":true}' }], { format, maxTokens: 40 }, fetcher);
  if (response.result?.connected !== true) throw new Error('Ollama 연결 응답을 확인하지 못했습니다.');
  return { connected: true, model: response.model };
}
