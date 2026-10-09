import { parseQuestions, buildGroups, importedScriptText } from './round-script.js';
import { analyzeAudioTiming, showTimingResult, parseTimingText, validateTimings, timingsText, timingConnection } from './audio-timing.js';

const $ = id => document.getElementById(id);
const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const API = '/api/past-exam';

async function request(action, selection, binary = false) {
  let response;
  try {
    response = await fetch(`${API}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(selection), signal: AbortSignal.timeout(action === 'translate-ai' ? 115000 : 65000) });
  } catch { throw new Error('자동 가져오기 서버에 연결하지 못했거나 시간이 초과되었습니다. 잠시 후 재시도하세요.'); }
  const type = response.headers.get('content-type') || '';
  if (!response.ok || (!binary && !type.includes('application/json'))) {
    const error = type.includes('application/json') ? await response.json() : null;
    throw new Error(error?.error || '자동 가져오기 서버가 준비되지 않았습니다. Firebase Functions와 Hosting을 함께 배포했는지 확인하세요.');
  }
  if (binary) {
    if (!type.includes('audio/')) throw new Error('전체 음원 대신 다른 응답을 받았습니다.');
    return response.blob();
  }
  return response.json();
}

export function initPastExamImport({ save }) {
  let draft = null, busy = false, objectUrl = '', timingController = null;
  const signature = questions => JSON.stringify(questions.map(q => [q.number, q.rows.map(r => r.english)]));
  function clearTimings() { if (draft) { draft.questionTimings = []; draft.timingSignature = ''; } $('importTimings').value = ''; $('importTimingResult').innerHTML = ''; $('importTimingStatus').textContent = ''; }
  function selectExamType() { const high = $('importGrade').value === '고1'; $('importMonthField').classList.toggle('hidden', !high); $('importSessionField').classList.toggle('hidden', high); }
  $('importGrade').addEventListener('change', selectExamType); selectExamType();
  const year = Number(new Intl.DateTimeFormat('en', { year: 'numeric', timeZone: 'Asia/Seoul' }).format(new Date()));
  $('importYear').max = String(year);
  const status = text => { $('importStatus').textContent = text; };
  const warnings = () => { $('importWarnings').innerHTML = (draft?.warnings || []).map(text => `<li>${escapeHtml(text)}</li>`).join(''); };
  function lock(value) {
    busy = value; $('pastExamCard').setAttribute('aria-busy', String(value));
    $('importEditor').disabled = value;
    for (const id of ['importYear', 'importGrade', 'importSession', 'importMonth']) $(id).disabled = value || Boolean(draft);
    $('importExamBtn').disabled = value || Boolean(draft);
  }
  function audio(blob) {
    clearTimings();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    draft.audioBlob = blob; draft.uploadedAudio = null;
    objectUrl = blob ? URL.createObjectURL(blob) : '';
    $('importAudio').pause(); $('importAudio').removeAttribute('src');
    if (objectUrl) $('importAudio').src = objectUrl;
    $('importAudio').classList.toggle('hidden', !blob);
  }
  function preview() {
    const questions = parseQuestions($('importScript').value, { allowEnglishOnly: true });
    if (draft?.timingSignature && draft.timingSignature !== signature(questions)) clearTimings();
    const untranslated = questions.flatMap(q => q.rows).filter(row => !row.korean).length;
    $('importSummary').textContent = `${questions.length}문항 · ${buildGroups(questions).length}묶음 · 해석 없는 줄 ${untranslated}개`;
    $('importQuestions').innerHTML = questions.map(q => `<div class="preview-q"><b>${q.number}번</b><div class="bilingual-preview">${q.rows.map(row => `<div>${escapeHtml(row.english)}</div><div>${escapeHtml(row.korean || '(해석 없음)')}</div>`).join('')}</div></div>`).join('');
    $('importSaveBtn').disabled = !questions.length;
    return questions;
  }
  async function fetchAudio() {
    try {
      const blob = await request('audio', draft.selection, true); audio(blob);
      draft.warnings = draft.warnings.filter(text => !text.startsWith('전체 음원 다운로드 실패:'));
    } catch (error) { draft.warnings.push(`전체 음원 다운로드 실패: ${error.message} 대본은 유지됩니다. 직접 파일을 선택하거나 다시 가져오세요.`); }
    warnings();
  }
  async function translate(replace = false) {
    const { apiKey, model } = timingConnection();
    if (replace && !apiKey) { status('AI 연결 설정에 Ollama API 키를 먼저 입력하세요.'); return; }
    draft.warnings = draft.warnings.filter(text => !/한국어 자동 번역|번역 요청 실패/.test(text));
    function merge(result) {
      // Preserve teacher edits on retry; only match exact official English rows.
      const current = parseQuestions($('importScript').value, { allowEnglishOnly: true });
      for (const question of current) {
        const original = result.questions.find(q => q.number === question.number);
        for (const [index, row] of question.rows.entries()) {
          const match = original?.rows[index]?.english === row.english ? original.rows[index] : original?.rows.find(item => item.english === row.english);
          if (replace || !row.korean) row.korean = match?.korean || row.korean || '';
        }
      }
      $('importScript').value = importedScriptText(current);
      draft.warnings.push(...result.warnings);
      $('importTranslationStatus').textContent = `번역: ${result.translationProvider || 'Google Cloud Translation'}${draft.warnings.some(text => /번역 요청 실패/.test(text)) ? ' · 일부 실패, 재시도 가능' : ''}`;
      preview();
    }
    try {
      const current = parseQuestions($('importScript').value, { allowEnglishOnly: true });
      if (!apiKey) merge(await request('translate', draft.selection));
      else {
        const pending = draft.questions.filter(q => current.some(item => item.number === q.number && item.rows.some(row => (replace || !row.korean) && q.rows.some(original => original.english === row.english))));
        const batches = []; let batch = [], size = 0;
        for (const question of pending) {
          const length = question.rows.reduce((sum, row) => sum + row.english.length, 0);
          if (batch.length && (batch.length >= 3 || size + length > 4000)) { batches.push(batch); batch = []; size = 0; }
          batch.push(question.number); size += length;
        }
        if (batch.length) batches.push(batch);
        for (const [index, numbers] of batches.entries()) {
          $('importTranslationStatus').textContent = `AI 한글 번역 중 · ${index + 1}/${batches.length} · ${model}`;
          try { merge(await request('translate-ai', { ...draft.selection, apiKey, model, numbers })); }
          catch (error) { draft.warnings.push(`번역 요청 실패: ${numbers.join('·')}번 · ${error.message} 영어 대본은 유지됩니다.`); }
        }
        $('importTranslationStatus').textContent = `번역: Ollama Cloud · ${model}${draft.warnings.some(text => /번역 요청 실패/.test(text)) ? ' · 일부 실패, 재시도 가능' : ' · 완료'}`;
      }
    } catch (error) { draft.warnings.push(`번역 요청 실패: ${error.message} 영어 대본은 유지됩니다.`); }
    warnings(); preview();
  }
  $('importExamBtn').addEventListener('click', async () => {
    if (busy || draft) return;
    const grade = $('importGrade').value;
    const selection = { year: Number($('importYear').value), grade, ...(grade === '고1' ? { month: Number($('importMonth').value) } : { session: Number($('importSession').value) }) };
    lock(true); status('자료 검색·다운로드·대본 분석 중…'); $('importWarnings').innerHTML = '';
    try {
      const result = await request('prepare', selection);
      draft = { ...result, selection, audioBlob: null, documentRef: null, questionTimings: [] }; clearTimings();
      $('importTranslationStatus').textContent = '';
      $('importTitle').value = result.title; $('importScript').value = importedScriptText(result.questions);
      $('importRawText').textContent = result.rawText;
      $('importSources').innerHTML = result.sources.map(source => {
        const links = [['공식 페이지', source.pageUrl], ['대본 PDF', source.scriptUrl], ['자료 ZIP', source.zipUrl], ['전체 음원 원본', source.audioUrl]];
        return `<p>${escapeHtml(source.name)}: ${links.filter(([, url]) => url).map(([label, url]) => `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`).join(' · ')}</p>`;
      }).join('');
      $('importPreview').classList.remove('hidden'); warnings(); preview();
      status(`대본 ${result.questions.length}문항 인식 · ${result.hasAudio ? '음원 발견' : '음원 없음'} · 번역·전체 음원 준비 중…`);
      await Promise.allSettled([result.questions.length ? translate() : Promise.resolve(), result.hasAudio ? fetchAudio() : Promise.resolve()]);
      status('미리보기 준비 완료. 대본과 음원을 확인·수정한 뒤 회차를 생성하세요.');
    } catch (error) { status(error.message); }
    finally { lock(false); }
  });
  $('importPreviewBtn').addEventListener('click', preview);
  $('importAiRetranslate').addEventListener('click', async () => {
    if (!draft || busy) return;
    if (!timingConnection().apiKey) { status('AI 연결 설정에 Ollama API 키를 먼저 입력하세요.'); return; }
    if (parseQuestions($('importScript').value, { allowEnglishOnly: true }).some(q => q.rows.some(row => row.korean)) && !confirm('미리보기의 기존 한글 해석을 Ollama AI 번역으로 바꿀까요? 직접 수정한 해석도 바뀌며, 아직 저장된 회차에는 반영되지 않습니다.')) return;
    lock(true);
    try { await translate(true); status('AI 번역 작업 완료. 미리보기와 경고를 확인하세요.'); }
    finally { lock(false); }
  });
  $('importAnalyzeTiming').addEventListener('click', async () => {
    if (!draft || busy) return;
    const questions = preview();
    if (!draft.audioBlob || !questions.length) { $('importTimingStatus').textContent = '전체 음원과 문항 대본을 먼저 준비하세요.'; return; }
    timingController = new AbortController(); lock(true); $('importCancelTiming').classList.remove('hidden');
    const progress = text => { $('importTimingStatus').textContent = text; };
    try {
      const result = await analyzeAudioTiming({ blob: draft.audioBlob, questions, status: progress, signal: timingController.signal });
      draft.questionTimings = result.timings; draft.timingSignature = signature(questions);
      $('importTimings').value = timingsText(result.timings); showTimingResult($('importTimingResult'), result, $('importAudio'));
      progress('자동 타이밍 제안 완료. 음원을 재생해 확인·수정한 뒤 회차를 생성하세요.');
    } catch (error) { progress(error.message); }
    finally { lock(false); timingController = null; $('importCancelTiming').classList.add('hidden'); }
  });
  $('importCancelTiming').addEventListener('click', () => timingController?.abort());
  $('importScript').addEventListener('input', preview);
  $('importAudioFile').addEventListener('change', event => {
    const file = event.target.files?.[0]; if (!file || !draft) return;
    if (!file.type.startsWith('audio/') || file.size >= 100 * 1024 * 1024) { status('100MB 미만의 오디오 파일을 선택하세요.'); event.target.value = ''; return; }
    audio(file); status('선택한 전체 음원을 미리보기에 준비했습니다.');
  });
  for (const [id, task] of [['importRetryAudio', fetchAudio], ['importRetryTranslation', translate]]) {
    $(id).addEventListener('click', async () => { if (!draft || busy) return; lock(true); status('다시 준비 중…'); try { await task(); status('재시도 완료. 미리보기와 경고를 확인하세요.'); } finally { lock(false); } });
  }
  $('importClearBtn').addEventListener('click', () => {
    if (busy) return;
    if (draft) audio(null); draft = null;
    $('importAudioFile').value = ''; $('importPreview').classList.add('hidden'); $('importWarnings').innerHTML = ''; status(''); lock(false);
  });
  $('importSaveBtn').addEventListener('click', async () => {
    if (!draft || busy) return;
    const questions = preview(), title = $('importTitle').value.trim();
    if (!title || title.length > 100 || !questions.length) return status('회차 이름과 문항 대본을 입력하세요.');
    if (questions.some((q, i) => q.number !== i + 1)) return status('문항 번호를 1번부터 순서대로, 중복 없이 입력하세요.');
    try {
      const text = $('importTimings').value.trim(), timings = parseTimingText(text);
      if (text && !timings.length) throw new Error('문항 시작 시간은 1번 00:56 형식으로 입력하세요.');
      draft.questionTimings = validateTimings(timings, questions);
    } catch (error) { return status(error.message); }
    lock(true); status('확인한 회차·음원 저장 중…');
    try {
      const result = await save({ draft, title, questions, groups: buildGroups(questions) });
      const hasTimings = draft.questionTimings.length > 0;
      audio(null); draft = null; $('importPreview').classList.add('hidden'); $('importWarnings').innerHTML = ''; $('importAudioFile').value = '';
      status(`회차를 생성했습니다. (${result.id}) ${hasTimings ? '문항별 시작 시간도 저장되었습니다.' : '등록된 회차에서 문항별 시작 시간을 입력하세요.'} 확인 후 ‘표시’를 누르세요.`);
    } catch (error) { status(`저장 실패: ${error.message} 미리보기 대본·음원을 유지했습니다. 다시 생성 버튼을 눌러 재시도할 수 있습니다.`); }
    finally { lock(false); }
  });
  window.addEventListener('beforeunload', event => { if (busy || draft) { event.preventDefault(); event.returnValue = ''; } });
  window.addEventListener('pagehide', event => { if (!event.persisted && objectUrl) URL.revokeObjectURL(objectUrl); });
}
