const $ = id => document.getElementById(id);
const escapeHtml = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const checkpoints = new WeakMap();
let active = false;
let speechWorker = null;

function recognizeLocally(buffer, start, end, status, signal, repair = false) {
  return new Promise((resolve, reject) => {
    speechWorker ||= new Worker(new URL('./speech-worker.js', import.meta.url), { type: 'module' });
    const worker = speechWorker;
    const abort = () => { worker.terminate(); speechWorker = null; reject(new Error('분석을 중지했습니다. 완료된 구간은 유지됩니다.')); };
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    worker.onerror = () => { signal?.removeEventListener('abort', abort); worker.terminate(); speechWorker = null; reject(new Error('기기 내 음성인식 모듈을 불러오지 못했습니다. 모델 다운로드 연결을 확인하세요.')); };
    worker.onmessage = event => {
      if (event.data.progress) { status(`${formatTiming(start)}~${formatTiming(end)} · ${event.data.progress}`); return; }
      signal?.removeEventListener('abort', abort);
      if (event.data.error) reject(new Error(event.data.error)); else resolve(event.data);
    };
    const first = Math.floor(start * 16000), last = Math.min(buffer.length, Math.floor(end * 16000));
    const audio = new Float32Array(last - first);
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      const samples = buffer.getChannelData(channel);
      for (let i = first; i < last; i++) audio[i - first] += samples[i] / buffer.numberOfChannels;
    }
    worker.postMessage({ audio, repair }, [audio.buffer]);
  });
}

export function formatTiming(seconds) {
  const sec = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
}
export function parseTimingText(text) {
  const normalized = text.replace(/<br\s*\/?\s*>/gi, '\n').replace(/\*\*/g, '');
  const re = /(\d{1,3})\s*번\s*(?:\||:|-)?\s*(\d{1,3}):([0-5]\d)(?::([0-5]\d))?/g;
  const byNumber = new Map(); let match;
  while ((match = re.exec(normalized))) byNumber.set(Number(match[1]), { number: Number(match[1]), start: match[4] === undefined ? Number(match[2]) * 60 + Number(match[3]) : Number(match[2]) * 3600 + Number(match[3]) * 60 + Number(match[4]) });
  return [...byNumber.values()].sort((a, b) => a.number - b.number);
}
export function validateTimings(timings, questions) {
  const text = q => q?.rows?.map(row => row.english.trim()).join('\n');
  const known = new Map(questions.map(q => [q.number, q]));
  for (let i = 0; i < timings.length; i++) {
    const current = timings[i], previous = timings[i - 1];
    if (!known.has(current.number) || !Number.isFinite(current.start) || current.start < 0) throw new Error('이 회차에 해당하는 문항 번호와 올바른 시간을 입력하세요.');
    if (previous && (current.start < previous.start || (current.start === previous.start && (current.number !== previous.number + 1 || text(known.get(current.number)) !== text(known.get(previous.number)))))) throw new Error('시간은 문항 순서대로 증가해야 합니다. 같은 대본을 공유하는 문항만 시작 시간이 같을 수 있습니다.');
  }
  return timings;
}
export function timingsText(timings) { return timings.map(t => `${t.number}번\t${formatTiming(t.start)}`).join('\n'); }
export function timingsMarkdown(timings) {
  const half = Math.ceil(timings.length / 2), lines = ['| 문항 | 시작 시간 | 문항 | 시작 시간 |', '|---:|:---:|---:|:---:|'];
  for (let i = 0; i < half; i++) {
    const a = timings[i], b = timings[i + half];
    lines.push(`| ${a.number}번 | **${formatTiming(a.start)}** | ${b ? `${b.number}번` : ''} | ${b ? `**${formatTiming(b.start)}**` : ''} |`);
  }
  return lines.join('\n');
}

async function request(action, body, signal) {
  let response;
  try {
    response = await fetch(`/api/past-exam/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(115000)]) : AbortSignal.timeout(115000) });
  } catch {
    if (signal?.aborted) throw new Error('분석을 중지했습니다. 완료된 음성인식 구간은 유지됩니다.');
    throw new Error('분석 서버 연결이 끊겼거나 시간이 초과되었습니다. 다시 누르면 완료된 구간부터 이어갑니다.');
  }
  if (!(response.headers.get('content-type') || '').includes('application/json')) throw new Error('타이밍 분석 서버가 아직 배포되지 않았습니다.');
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '타이밍 분석 요청이 실패했습니다.');
  return data;
}
export function timingConnection() {
  return { apiKey: $('ollamaApiKey').value.trim(), model: $('ollamaModel').value.trim(), includeInstructions: $('timingIncludeInstructions').checked };
}
export function initTimingSettings() {
  $('ollamaConnectBtn').addEventListener('click', async () => {
    const button = $('ollamaConnectBtn'); button.disabled = true; $('ollamaStatus').textContent = '연결 확인 중…';
    try { const result = await request('ollama', timingConnection()); $('ollamaStatus').textContent = `${result.model} 연결 확인 완료`; }
    catch (error) { $('ollamaStatus').textContent = error.message; }
    finally { button.disabled = false; }
  });
  $('ollamaForgetBtn').addEventListener('click', () => { $('ollamaApiKey').value = ''; $('ollamaStatus').textContent = 'API 키를 이 탭에서 지웠습니다.'; });
  $('ollamaApiKey').addEventListener('input', () => { $('ollamaStatus').textContent = '새 API 키가 입력되었습니다. 연결 확인을 누르세요.'; });
  window.addEventListener('beforeunload', event => { if (active) { event.preventDefault(); event.returnValue = ''; } });
}
export function pcmBase64(buffer, start, end) {
  const first = Math.floor(start * 16000), last = Math.min(buffer.length, Math.floor(end * 16000));
  const bytes = new Uint8Array((last - first) * 2), view = new DataView(bytes.buffer);
  for (let i = first; i < last; i++) {
    let sample = 0;
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) sample += buffer.getChannelData(channel)[i] / buffer.numberOfChannels;
    sample = Math.max(-1, Math.min(1, sample));
    view.setInt16((i - first) * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
export function dedupeWords(words) {
  const normalized = word => word.text.toLowerCase().replace(/[.,!?]/g, '');
  const sorted = [...words].sort((a, b) => a.start - b.start), out = [];
  for (const word of sorted) if (!out.slice(-8).some(prev => Math.abs(prev.start - word.start) < 0.5 && normalized(prev) === normalized(word))) out.push(word);
  return out;
}
export async function analyzeAudioTiming({ blob, questions, status, signal }) {
  if (active) throw new Error('다른 음원을 분석 중입니다. 해당 분석을 완료하거나 중지하세요.');
  if (!blob || blob.size >= 100 * 1024 * 1024) throw new Error('100MB 미만의 전체 음원이 필요합니다.');
  active = true;
  try {
    const provider = $('timingSpeechProvider').value;
    let checkpoint = checkpoints.get(blob);
    if (checkpoint && checkpoint.provider !== provider) checkpoint = null;
    if (!checkpoint) {
      status('전체 음원 읽기·분석 준비 중…');
      const context = new OfflineAudioContext(1, 1, 16000);
      let buffer;
      try { buffer = await context.decodeAudioData(await blob.arrayBuffer()); }
      catch { throw new Error('브라우저에서 음원을 읽지 못했습니다. MP3 또는 WAV 전체 음원을 선택하세요.'); }
      if (buffer.duration > 2400 || buffer.duration < 1) throw new Error('1초 이상 40분 이하의 전체 음원을 선택하세요.');
      checkpoint = { buffer, duration: buffer.duration, next: 0, words: [], provider }; checkpoints.set(blob, checkpoint);
    }
    while (checkpoint.next < checkpoint.duration - 0.1) {
      if (signal?.aborted) throw new Error('분석을 중지했습니다. 완료된 음성인식 구간은 유지됩니다.');
      const start = checkpoint.next, length = provider === 'local' ? 30 : 45, overlap = provider === 'local' ? 5 : 1, end = Math.min(start + length, checkpoint.duration);
      status(`음성인식 중 ${formatTiming(start)} / ${formatTiming(checkpoint.duration)} · 완료 구간은 재분석하지 않습니다.`);
      const result = provider === 'local' ? await recognizeLocally(checkpoint.buffer, start, end, status, signal) : await request('recognize', { content: pcmBase64(checkpoint.buffer, start, end) }, signal);
      checkpoint.words = dedupeWords([...checkpoint.words, ...result.words.map(word => ({ ...word, start: word.start + start, end: Math.min(checkpoint.duration, word.end + start) }))]);
      checkpoint.next = end >= checkpoint.duration - 0.1 ? checkpoint.duration : start + length - overlap;
    }
    if (provider === 'local') {
      const scan = await request('timing-scan', { questions, words: checkpoint.words, duration: checkpoint.duration }, signal);
      checkpoint.retries ||= new Set();
      let missing = scan.missing;
      for (const window of scan.windows) {
        if (!missing.includes(window.number)) continue;
        const key = `${window.start}:${window.end}`;
        if (checkpoint.retries.has(key)) continue;
        status(`${window.number}번 대조 보완 중 ${formatTiming(window.start)}~${formatTiming(window.end)} · 놓친 구간을 다시 인식합니다.`);
        const result = await recognizeLocally(checkpoint.buffer, window.start, window.end, status, signal, true);
        checkpoint.words = dedupeWords([...checkpoint.words, ...result.words.map(word => ({ ...word, start: word.start + window.start, end: Math.min(checkpoint.duration, word.end + window.start) }))]);
        checkpoint.retries.add(key);
        ({ missing } = await request('timing-scan', { questions, words: checkpoint.words, duration: checkpoint.duration }, signal));
      }
    }
    const connection = timingConnection();
    status(connection.apiKey ? 'DeepSeek로 실제 음성인식 시간과 문항 대본 대조 중…' : '실제 음성인식 시간과 문항 대본 대조 중…');
    const result = await request('timings', { ...connection, questions, words: checkpoint.words, duration: checkpoint.duration }, signal);
    result.provider = `${provider === 'local' ? '이 기기 Whisper 음성인식' : 'Google 음성인식'} + ${result.model ? 'Ollama DeepSeek 대조' : '대본 대조'}`;
    validateTimings(result.timings, questions);
    return result;
  } finally { active = false; }
}
export function showTimingResult(container, result, audio) {
  const timings = result.timings, half = Math.ceil(timings.length / 2);
  const cell = timing => timing ? `<td>${timing.number}번${timing.sharedWith ? ' (공통)' : ''}</td><td><button type="button" class="btn ghost small" data-seek-time="${timing.start}">${formatTiming(timing.start)} ▶</button></td>` : '<td></td><td></td>';
  container.innerHTML = `<p class="help">${escapeHtml(result.provider)} · ${timings.length}문항 제안. 시간을 눌러 음원을 확인한 후 저장하세요.</p><div class="table-wrap"><table><thead><tr><th>문항</th><th>시작 시간</th><th>문항</th><th>시작 시간</th></tr></thead><tbody>${Array.from({ length: half }, (_, i) => `<tr>${cell(timings[i])}${cell(timings[i + half])}</tr>`).join('')}</tbody></table></div><ul class="import-warnings">${(result.warnings || []).map(w => `<li>${escapeHtml(w)}</li>`).join('')}</ul><button type="button" class="btn small" data-copy-timing-table>시간 표 복사</button>`;
  container.querySelectorAll('[data-seek-time]').forEach(button => button.addEventListener('click', () => { if (!audio) return; audio.currentTime = Number(button.dataset.seekTime); audio.play().catch(() => {}); }));
  container.querySelector('[data-copy-timing-table]').addEventListener('click', async event => {
    try { await navigator.clipboard.writeText(timingsMarkdown(timings)); event.target.textContent = '복사 완료'; }
    catch { event.target.textContent = '클립보드 권한을 확인하세요.'; }
  });
}
