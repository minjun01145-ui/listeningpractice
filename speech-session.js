// Runs one Whisper job on the worker. Limits count only time while the page is
// visible: Chrome pauses background tabs, and a wall-clock limit would then
// cancel a healthy analysis as soon as the teacher came back to the tab.
export function runSpeechWorker(worker, audio, { signal, language = 'en', progress = () => {}, loadingIdleMs = 120000, inferenceMs = 180000, tickMs = 1000, isHidden = () => Boolean(globalThis.document?.hidden) } = {}) {
  return new Promise((resolve, reject) => {
    let phase = 'loading', active = 0, quiet = 0, settled = false, label = 'Whisper 모델 준비 중…';
    const started = Date.now();
    const report = () => progress(`${label} · 경과 ${Math.floor((Date.now() - started) / 1000)}초`);
    const finish = (error, data) => {
      if (settled) return;
      settled = true; clearInterval(timer); signal?.removeEventListener('abort', abort);
      worker.onmessage = worker.onerror = worker.onmessageerror = null;
      if (error) { worker.terminate(); reject(error); } else resolve(data);
    };
    const abort = () => finish(new Error('분석을 중지했습니다. 완료된 구간은 저장되어 다시 누르면 이어서 진행합니다.'));
    const timer = setInterval(() => {
      if (isHidden()) return;
      active += tickMs; quiet += tickMs;
      if (phase === 'loading' && quiet >= loadingIdleMs) return finish(new Error('음성인식 모델 다운로드가 멈췄습니다. 인터넷 연결을 확인하고 다시 분석하세요. 완료 구간은 유지됩니다.'));
      if (phase === 'recognizing' && active >= inferenceMs) return finish(new Error('음성인식이 응답하지 않아 중지했습니다. 다른 무거운 프로그램을 닫고 다시 분석하세요. 완료 구간은 유지됩니다.'));
      report();
    }, tickMs);
    worker.onerror = () => finish(new Error('음성인식 모듈을 실행하지 못했습니다. 인터넷 연결과 브라우저 메모리를 확인하세요.'));
    worker.onmessageerror = () => finish(new Error('음성인식 응답을 읽지 못했습니다. 다시 분석하세요.'));
    worker.onmessage = event => {
      if (settled) return;
      const data = event.data; quiet = 0;
      if (data.phase === 'recognizing' && phase !== 'recognizing') { phase = 'recognizing'; active = 0; }
      if (data.progress) { label = data.progress; report(); return; }
      if (data.error) return finish(new Error(data.error));
      if (!Array.isArray(data.segments)) return finish(new Error('음성인식 응답이 올바르지 않습니다. 다시 분석하세요.'));
      finish(null, data);
    };
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    report();
    try { worker.postMessage({ audio, language }, [audio.buffer]); }
    catch (error) { finish(error); }
  });
}
