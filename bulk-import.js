import { parseQuestions, buildGroups, importedScriptText } from './round-script.js';
import { analyzeAudioTiming, validateTimings, timingConnection, formatTiming } from './audio-timing.js';
import { request } from './auto-import.js?v=20261010-2';

const $ = id => document.getElementById(id);
const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const MIDDLE = ['중1', '중2', '중3'];
const MONTHS = [3, 4, 6, 8, 9, 10, 11, 12];
const DEFAULT_MONTHS = [3, 6, 9, 11];
// Share of one exam's work per step; timing analysis dominates.
const STEPS = { prepare: 0.04, translate: 0.08, audio: 0.04, timing: 0.8, save: 0.04 };

// Must match the server's titles (functions/import-service.js) to skip saved rounds.
export function examTitle({ year, grade, session, month }) {
  return grade === '고1' ? `${year}년 ${month}월 고1 모의고사 영어듣기` : `${year}년 ${grade} 영어듣기평가 제${session}회`;
}

// Ollama: one question per request, three at a time, one retry for failures.
async function translateWithAi(questions, { apiKey, model, grade }, signal, onProgress) {
  const failures = new Map(); let done = 0, fatal = '';
  const pending = questions.filter(q => q.rows.some(row => !row.korean));
  const run = async list => {
    const queue = [...list];
    const worker = async () => {
      for (let question; (question = queue.shift());) {
        if (signal.aborted) return;
        const english = question.rows.map(row => row.english);
        try {
          const result = await request('translate-ai', { apiKey, model, grade, number: question.number, rows: english });
          question.rows.forEach((row, index) => { if (!row.korean && result.korean[index]) row.korean = result.korean[index]; });
          if (result.missing) failures.set(question.number, `${result.missing}줄 누락`); else failures.delete(question.number);
        } catch (error) {
          failures.set(question.number, error.message);
          if (/인증|API 키|모델을 찾지|모델명/.test(error.message)) { fatal = error.message; queue.length = 0; }
        }
        onProgress(Math.min(1, ++done / pending.length));
      }
    };
    await Promise.all([worker(), worker(), worker()]);
  };
  await run(pending);
  if (failures.size && !fatal && !signal.aborted) await run(pending.filter(q => failures.has(q.number)));
  if (fatal) return [`AI 번역 실패: ${fatal}`];
  // One line per reason: "3·7·12번 해석 번역 실패 (사유)".
  const byReason = new Map();
  for (const [number, message] of failures) byReason.set(message, [...(byReason.get(message) || []), number]);
  return [...byReason].map(([message, numbers]) => `${numbers.sort((x, y) => x - y).join('·')}번 해석 번역 실패 (${message}) — 회차 편집에서 직접 입력하세요.`);
}

export function initBulkImport({ save, rounds }) {
  let controller = null, wakeLock = null;
  const year = Number(new Intl.DateTimeFormat('en', { year: 'numeric', timeZone: 'Asia/Seoul' }).format(new Date()));
  $('bulkYear').max = String(year);
  const options = [
    ...MIDDLE.flatMap(grade => [1, 2].map(session => ({ grade, session, label: `${grade} ${session}회`, checked: true }))),
    ...MONTHS.map(month => ({ grade: '고1', month, label: `고1 ${month}월`, checked: DEFAULT_MONTHS.includes(month) })),
  ];
  $('bulkChoices').innerHTML = ['중1', '중2', '중3', '고1'].map(grade => `<div class="bulk-row"><b>${grade}</b>${options.map((option, index) => option.grade === grade ? `<label class="bulk-choice"><input type="checkbox" data-bulk-choice="${index}" ${option.checked ? 'checked' : ''}> ${escapeHtml(option.label.replace(`${grade} `, ''))}</label>` : '').join('')}</div>`).join('');
  const boxes = () => [...document.querySelectorAll('[data-bulk-choice]')];
  $('bulkSelectAll').addEventListener('click', () => boxes().forEach(box => { box.checked = true; }));
  $('bulkSelectNone').addEventListener('click', () => boxes().forEach(box => { box.checked = false; }));

  const results = [];
  const badge = { 완료: 'success', '확인 필요': 'warn', 건너뜀: '', 실패: 'danger', 중지: 'warn', 대기: '', 진행중: '' };
  function render() {
    $('bulkResults').innerHTML = results.length ? `<div class="table-wrap"><table><thead><tr><th>시험</th><th>상태</th><th>확인 사항</th></tr></thead><tbody>${results.map(row => `<tr><td>${escapeHtml(row.title)}</td><td><span class="status-pill ${badge[row.state] || ''}">${escapeHtml(row.state)}</span></td><td>${row.notes.length ? `<ul class="import-warnings">${row.notes.map(note => `<li>${escapeHtml(note)}</li>`).join('')}</ul>` : '-'}</td></tr>`).join('')}</tbody></table></div>` : '';
    const count = state => results.filter(row => row.state === state).length;
    $('bulkSummary').textContent = results.length ? `완료 ${count('완료')} · 확인 필요 ${count('확인 필요')} · 건너뜀 ${count('건너뜀')} · 실패 ${count('실패')}${count('중지') ? ` · 중지 ${count('중지')}` : ''}` : '';
  }
  function setProgress(fraction, text) {
    const percent = Math.max(0, Math.min(100, fraction * 100));
    $('bulkProgress').value = percent; $('bulkPercent').textContent = `${percent.toFixed(1)}%`;
    if (text !== undefined) $('bulkStatus').textContent = text;
  }
  function lock(running) {
    $('bulkStartBtn').disabled = running; $('bulkStopBtn').classList.toggle('hidden', !running);
    $('bulkYear').disabled = running; boxes().forEach(box => { box.disabled = running; });
    $('importExamBtn').disabled = running;
  }

  async function processExam(selection, row, signal, report) {
    const notes = row.notes, stage = (from, share) => fraction => report(from + share * fraction);
    let offset = 0;
    report(0); row.state = '진행중'; render();
    $('bulkStep').textContent = '대본·음원 자료 찾는 중…';
    let preview;
    try { preview = await request('prepare', selection); }
    catch (error) {
      if (/찾지 못했습니다|자료가 없|확인하고 수동/.test(error.message)) { row.state = '건너뜀'; notes.push(`공식 자료 없음: ${error.message}`); return; }
      throw error;
    }
    notes.push(...preview.warnings);
    offset += STEPS.prepare; report(offset);
    if (!preview.questions.length) { row.state = '실패'; notes.push('대본 문항을 인식하지 못했습니다. ‘기출 자동 불러오기’로 열어 직접 입력하세요.'); return; }
    const questions = structuredClone(preview.questions);

    $('bulkStep').textContent = '한글 해석 번역 중…';
    const connection = timingConnection();
    if (connection.apiKey) notes.push(...await translateWithAi(questions, { ...connection, grade: selection.grade }, signal, stage(offset, STEPS.translate)));
    else {
      try {
        const result = await request('translate', selection);
        for (const question of questions) question.rows.forEach((row, index) => { row.korean ||= result.questions.find(q => q.number === question.number)?.rows[index]?.korean || ''; });
        notes.push(...result.warnings);
      } catch (error) { notes.push(`번역 실패: ${error.message} (AI 연결 설정에 Ollama 키를 넣으면 AI로 번역합니다.)`); }
    }
    if (signal.aborted) throw new DOMException('stopped', 'AbortError');
    offset += STEPS.translate; report(offset);

    $('bulkStep').textContent = '전체 음원 내려받는 중…';
    let audio = null;
    if (preview.hasAudio) {
      try { audio = await request('audio', selection, true); }
      catch (error) { notes.push(`전체 음원 다운로드 실패: ${error.message} 회차 편집에서 음원을 직접 올리세요.`); }
    } else notes.push('전체 음원이 없습니다. 회차 편집에서 음원을 직접 올리세요.');
    offset += STEPS.audio; report(offset);

    const parsed = parseQuestions(importedScriptText(questions), { allowEnglishOnly: true });
    let timings = [];
    if (audio) {
      try {
        const result = await analyzeAudioTiming({ blob: audio, questions: parsed, signal, status: text => { $('bulkStep').textContent = `자동 타이밍 · ${text}`; }, progress: stage(offset, STEPS.timing) });
        timings = validateTimings(result.timings, parsed);
        notes.push(...result.warnings);
      } catch (error) {
        if (signal.aborted) throw new DOMException('stopped', 'AbortError');
        notes.push(`자동 타이밍 실패: ${error.message} 회차 편집에서 다시 분석하거나 직접 입력하세요.`);
      }
    }
    offset += STEPS.timing; report(offset);
    if (signal.aborted) throw new DOMException('stopped', 'AbortError');

    $('bulkStep').textContent = '회차 저장 중…';
    const draft = { selection, grade: selection.grade, audioBlob: audio, documentRef: null, uploadedAudio: null, questionTimings: timings };
    const title = preview.title || examTitle(selection);
    // Storage/Firestore hiccups are retried once with the same round ID and path.
    try { await save({ draft, title, questions: parsed, groups: buildGroups(parsed) }); }
    catch { await save({ draft, title, questions: parsed, groups: buildGroups(parsed) }); }
    report(1);
    const untranslated = parsed.flatMap(q => q.rows).filter(r => !r.korean && !/^(?:(?:[MWBF]|[A-Z][a-z]+)\s*:\s*)?[_\s.]*$/.test(r.english)).length;
    if (untranslated) notes.push(`해석이 비어 있는 줄 ${untranslated}개`);
    notes.push(timings.length ? `문항 시간 ${timings.length}/${parsed.length}개 저장 (${formatTiming(timings[0].start)}~)` : '문항 시간 없음 — 회차 편집에서 분석하거나 입력하세요.');
    row.state = notes.length > 1 || untranslated || timings.length < parsed.length ? '확인 필요' : '완료';
  }

  $('bulkStartBtn').addEventListener('click', async () => {
    if (controller) return;
    const selectedYear = Number($('bulkYear').value);
    if (!Number.isInteger(selectedYear) || selectedYear < 2017 || selectedYear > year) { $('bulkStatus').textContent = '2017년 이후 연도를 입력하세요.'; return; }
    const chosen = boxes().filter(box => box.checked).map(box => options[Number(box.dataset.bulkChoice)]);
    if (!chosen.length) { $('bulkStatus').textContent = '불러올 학년·회차를 하나 이상 체크하세요.'; return; }
    controller = new AbortController(); lock(true); setProgress(0, `${chosen.length}개 시험 불러오기를 시작합니다…`);
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
    const signal = controller.signal, existing = new Set(rounds().map(round => round.title));
    results.length = 0;
    const jobs = chosen.map(option => {
      const selection = { year: selectedYear, grade: option.grade, ...(option.grade === '고1' ? { month: option.month } : { session: option.session }) };
      const row = { title: examTitle(selection), state: '대기', notes: [] };
      results.push(row);
      return { selection, row };
    });
    render();
    for (const [index, { selection, row }] of jobs.entries()) {
      const report = fraction => setProgress((index + fraction) / jobs.length, `${index + 1}/${jobs.length} · ${row.title}`);
      if (signal.aborted) { row.state = '중지'; continue; }
      if ($('bulkSkipExisting').checked && existing.has(row.title)) { row.state = '건너뜀'; row.notes.push('이미 등록된 회차입니다.'); report(1); render(); continue; }
      try { await processExam(selection, row, signal, report); }
      catch (error) {
        if (signal.aborted) { row.state = '중지'; row.notes.push('중지됨 — 저장되지 않았습니다. 다시 시작하면 이 시험부터 이어서 진행합니다(받아쓴 음원 구간은 재사용).'); }
        else { row.state = '실패'; row.notes.push(error.message); }
      }
      render();
    }
    const finished = results.filter(row => ['완료', '확인 필요'].includes(row.state)).length;
    setProgress(signal.aborted ? $('bulkProgress').value / 100 : 1, signal.aborted ? `중지했습니다. 저장된 ${finished}개 회차는 유지됩니다. 다시 시작하면 남은 시험부터 진행합니다.` : `전체 작업 완료 · ${finished}개 회차 저장. 새 회차는 학생에게 숨김 상태이니 확인 후 ‘표시’를 누르세요.`);
    $('bulkStep').textContent = '';
    try { await wakeLock?.release(); } catch {}
    wakeLock = null; controller = null; lock(false);
  });
  $('bulkStopBtn').addEventListener('click', () => { if (controller && confirm('지금 진행 중인 시험은 저장하지 않고 중지합니다. 이미 저장된 회차는 유지됩니다. 중지할까요?')) controller.abort(); });
  window.addEventListener('beforeunload', event => { if (controller) { event.preventDefault(); event.returnValue = ''; } });
}
