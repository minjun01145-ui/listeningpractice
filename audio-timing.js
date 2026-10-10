import { runSpeechWorker } from './speech-session.js?v=20261010-1';
import { energyProfile, speechOnsets, chunkPlan, quietestPoint, badTranscript, uncoveredSpeech, annotation, alignQuestions, cueWindows, findCue, findInstruction, questionStart, silenceStart, buildTimings } from './timing-match.js?v=20261010-1';


const $ = id => document.getElementById(id);
const escapeHtml = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const SETTINGS_KEY = 'listening-teacher:ollama';
const CACHE_PREFIX = 'listening-teacher:asr:v3:';
const checkpoints = new Map();
let active = false;
let speechWorker = null;

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

async function request(action, body) {
  let response;
  try {
    response = await fetch(`/api/past-exam/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(65000) });
  } catch { throw new Error('서버에 연결하지 못했거나 시간이 초과되었습니다. 잠시 후 다시 시도하세요.'); }
  if (!(response.headers.get('content-type') || '').includes('application/json')) throw new Error('서버가 아직 배포되지 않았거나 응답 시간이 초과되었습니다.');
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '요청이 실패했습니다.');
  return data;
}

// The key stays in this browser only (never Firestore/Storage); requests pass it to Ollama.
function readSettings() { try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null'); } catch { return null; } }
export function timingConnection() {
  return { apiKey: $('ollamaApiKey').value.trim(), model: $('ollamaModel').value.trim() || 'deepseek-v4.1-flash', includeInstructions: $('timingIncludeInstructions').checked };
}
export function initTimingSettings() {
  const saved = readSettings(), status = text => { $('ollamaStatus').textContent = text; };
  if (saved?.apiKey) { $('ollamaApiKey').value = saved.apiKey; $('ollamaModel').value = saved.model || $('ollamaModel').value; status('저장된 API 키를 불러왔습니다.'); }
  else $('timingSettings').open = true;
  $('ollamaSaveBtn').addEventListener('click', () => {
    const { apiKey, model } = timingConnection();
    if (!apiKey) return status('저장할 API 키를 입력하세요.');
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ apiKey, model })); status('이 브라우저에 저장했습니다. 다음에 들어와도 자동으로 입력됩니다.'); }
    catch { status('브라우저 저장소를 사용할 수 없어 저장하지 못했습니다. (시크릿 창이면 일반 창에서 저장하세요.)'); }
  });
  $('ollamaConnectBtn').addEventListener('click', async () => {
    const button = $('ollamaConnectBtn'); button.disabled = true; status('연결 확인 중…');
    try {
      const result = await request('ollama', timingConnection());
      const stored = readSettings();
      status(`${result.model} 연결 확인 완료${stored?.apiKey === timingConnection().apiKey ? ' · 저장됨' : ' · 다음에도 쓰려면 ‘저장’을 누르세요'}`);
    } catch (error) { status(error.message); }
    finally { button.disabled = false; }
  });
  $('ollamaForgetBtn').addEventListener('click', () => {
    $('ollamaApiKey').value = '';
    try { localStorage.removeItem(SETTINGS_KEY); } catch {}
    status('API 키를 지우고 이 브라우저의 저장 기록도 삭제했습니다.');
  });
  $('ollamaApiKey').addEventListener('input', () => status('새 API 키가 입력되었습니다. ‘저장’ 후 ‘연결 확인’을 누르세요.'));
  window.addEventListener('beforeunload', event => { if (active) { event.preventDefault(); event.returnValue = ''; } });
}

async function fingerprint(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest).slice(0, 12)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function loadCheckpoint(id) {
  if (checkpoints.has(id)) return checkpoints.get(id);
  let stored = null;
  try { stored = JSON.parse(localStorage.getItem(CACHE_PREFIX + id) || 'null'); } catch {}
  const checkpoint = { id, english: stored?.english || {}, repair: stored?.repair || {}, korean: stored?.korean || {} };
  checkpoints.set(id, checkpoint);
  return checkpoint;
}
// Recognized text survives a reload, so a new attempt continues where it stopped.
function saveCheckpoint(checkpoint) {
  try {
    const keys = Object.keys(localStorage).filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_PREFIX + checkpoint.id);
    for (const key of keys.slice(0, Math.max(0, keys.length - 3))) localStorage.removeItem(key);
    localStorage.setItem(CACHE_PREFIX + checkpoint.id, JSON.stringify({ english: checkpoint.english, repair: checkpoint.repair, korean: checkpoint.korean }));
  } catch {}
}

async function transcribe(samples, start, end, language, signal, progress) {
  speechWorker ||= new Worker(new URL('./speech-worker.js?v=20261010-1', import.meta.url), { type: 'module' });
  const audio = samples.slice(Math.floor(start * 16000), Math.floor(end * 16000));
  try {
    const result = await runSpeechWorker(speechWorker, audio, { signal, language, progress });
    return result.segments.map(segment => ({ text: segment.text, start: +(segment.start + start).toFixed(2), end: +(segment.end + start).toFixed(2) }));
  } catch (error) { speechWorker = null; throw error; }
}

async function decode(blob) {
  const context = new OfflineAudioContext(1, 1, 16000);
  let buffer;
  try { buffer = await context.decodeAudioData(await blob.arrayBuffer()); }
  catch { throw new Error('브라우저에서 음원을 읽지 못했습니다. MP3 또는 WAV 전체 음원을 선택하세요.'); }
  if (buffer.duration > 2400 || buffer.duration < 5) throw new Error('5초 이상 40분 이하의 전체 음원을 선택하세요.');
  const samples = new Float32Array(buffer.length);
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < data.length; i++) samples[i] += data[i] / buffer.numberOfChannels;
  }
  return samples;
}

const minutes = ms => ms < 60000 ? '1분 이내' : `약 ${Math.round(ms / 60000)}분`;

// 1) Whisper writes down the English dialogue (whole file, chunks cut at pauses),
// 2) each question's script is aligned to it, 3) a short Korean pass finds "N번".
// progress(fraction 0..1) is optional and only reports how far the analysis is.
export async function analyzeAudioTiming({ blob, questions, status, signal, progress = () => {}, debug = false }) {
  if (active) throw new Error('다른 음원을 분석 중입니다. 해당 분석을 완료하거나 중지하세요.');
  if (!blob || blob.size >= 100 * 1024 * 1024) throw new Error('100MB 미만의 전체 음원이 필요합니다.');
  if (!questions?.length) throw new Error('문항 대본이 필요합니다.');
  active = true;
  const run = async () => {
    status('전체 음원 읽는 중…');
    const bytes = await blob.arrayBuffer();
    const checkpoint = loadCheckpoint(await fingerprint(bytes));
    const samples = await decode(new Blob([bytes]));
    const profile = energyProfile(samples), onsets = speechOnsets(profile), duration = profile.duration;
    const chunks = chunkPlan(profile);
    const started = Date.now(); let done = 0;
    const todo = chunks.filter(chunk => !checkpoint.english[chunk.start.toFixed(2)]).length;
    for (const [index, chunk] of chunks.entries()) {
      progress(0.85 * index / chunks.length);
      const key = chunk.start.toFixed(2);
      if (checkpoint.english[key]) continue;
      if (signal?.aborted) throw new Error('분석을 중지했습니다. 완료된 구간은 저장되어 다시 누르면 이어서 진행합니다.');
      const remaining = done ? minutes((Date.now() - started) / done * (todo - done)) : '계산 중';
      const label = `1/2단계 영어 대화 인식 ${index + 1}/${chunks.length}구간 (${formatTiming(chunk.start)}/${formatTiming(duration)}) · 남은 시간 ${remaining}`;
      const listen = (start, end) => transcribe(samples, start, end, 'en', signal, text => status(`${label} · ${text}`));
      let heard = await listen(chunk.start, chunk.end);
      // A looping or stretched transcript: try again as two halves cut at a pause.
      if (badTranscript(heard) && chunk.end - chunk.start > 12) {
        const middle = quietestPoint(profile, chunk.start + (chunk.end - chunk.start) * 0.35, chunk.start + (chunk.end - chunk.start) * 0.65);
        heard = [...await listen(chunk.start, middle), ...await listen(middle, chunk.end)];
      }
      checkpoint.english[key] = heard.filter(segment => !badTranscript([segment]));
      done++; saveCheckpoint(checkpoint);
    }
    let segments = chunks.flatMap(chunk => checkpoint.english[chunk.start.toFixed(2)] || []);
    let alignment = alignQuestions(questions, segments);
    // Whisper sometimes skips a dialogue's opening (often right after a Korean "N번").
    // For a question that was not found, sound that no segment covers between its
    // found neighbours is heard again on its own, then everything is aligned again.
    const gaps = [];
    alignment.forEach((item, index) => {
      if (item.englishStart !== null || item.sharedWith) return;
      const before = alignment.slice(0, index).reverse().find(other => other.englishStart !== null), after = alignment.slice(index + 1).find(other => other.englishStart !== null);
      for (const gap of uncoveredSpeech(profile, segments, before ? before.englishStart + 2 : 0, after ? after.englishStart : duration).slice(0, 4)) if (!gaps.some(other => other.start === gap.start)) gaps.push(gap);
    });
    for (const [index, gap] of gaps.entries()) {
      progress(0.85 + 0.05 * index / gaps.length);
      const key = `${gap.start.toFixed(1)}-${gap.end.toFixed(1)}`;
      if (signal?.aborted) throw new Error('분석을 중지했습니다. 완료된 구간은 저장되어 다시 누르면 이어서 진행합니다.');
      checkpoint.repair[key] ||= (await transcribe(samples, Math.max(0, gap.start - 0.3), Math.min(duration, gap.end + 0.5, gap.start + 29), 'en', signal, text => status(`1/2단계 놓친 대화 다시 듣기 ${index + 1}/${gaps.length} · ${text}`)))
        .filter(segment => !badTranscript([segment]) && !annotation(segment.text));
      saveCheckpoint(checkpoint);
    }
    if (gaps.length) {
      segments = [...segments, ...gaps.flatMap(gap => checkpoint.repair[`${gap.start.toFixed(1)}-${gap.end.toFixed(1)}`] || [])].sort((x, y) => x.start - y.start);
      alignment = alignQuestions(questions, segments);
    }
    const cues = [];
    for (const [index, item] of alignment.entries()) {
      progress(0.9 + 0.1 * index / alignment.length);
      if (item.sharedWith) { cues.push(null); continue; }
      const windows = cueWindows(alignment, index, segments, onsets, duration);
      const around = item.englishStart === null ? windows : [{ start: Math.max(0, item.englishStart - 26), end: item.englishStart + 1 }];
      let time = around.length ? findCue(segments, item.number, around[0].start, around.at(-1).end) : null;
      for (const window of windows) {
        if (time !== null) break;
        if (signal?.aborted) throw new Error('분석을 중지했습니다. 완료된 구간은 저장되어 다시 누르면 이어서 진행합니다.');
        const key = `${window.start.toFixed(1)}-${window.end.toFixed(1)}`;
        checkpoint.korean[key] ||= await transcribe(samples, window.start, window.end, 'ko', signal, text => status(`2/2단계 ${item.number}번 안내 위치 확인 (${index + 1}/${alignment.length}) · ${text}`));
        saveCheckpoint(checkpoint);
        time = findCue(checkpoint.korean[key], item.number, window.start, window.end);
        if (time === null && !window.scan) time = findInstruction(checkpoint.korean[key], window.start, window.end);
      }
      if (time === null && item.englishStart !== null) { const after = silenceStart(item.englishStart, onsets); if (after !== null) { cues.push({ time: after }); continue; } }
      cues.push(time === null ? null : { time: questionStart(time, onsets) });
    }
    const result = buildTimings(questions, alignment, cues, $('timingIncludeInstructions')?.checked !== false);
    validateTimings(result.timings, questions);
    return { ...result, duration, provider: '이 기기 Whisper 음성인식 + 대본 대조', ...(debug ? { debug: { segments, alignment, cues, korean: checkpoint.korean, chunks } } : {}) };
  };
  try {
    // Holding a Web Lock tells the browser this tab is busy (helps avoid tab freezing).
    return navigator.locks ? await navigator.locks.request('listening-timing-analysis', run) : await run();
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
