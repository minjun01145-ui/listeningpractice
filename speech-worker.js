import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';
import { sizedModelResponse } from './speech-download.js';

// Multilingual Whisper: English for the dialogue, Korean for the "N번" instructions.
const MODEL = 'onnx-community/whisper-base';
env.allowLocalModels = false;
env.backends.onnx.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
let transcriber = null;
const originalFetch = self.fetch.bind(self);
const modelUrl = input => { try { const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url); return url.hostname === 'huggingface.co' && url.pathname.startsWith(`/${MODEL}/resolve/`); } catch { return false; } };
const reportBytes = size => self.postMessage({ phase: 'loading', progress: `음성인식 모델 내려받는 중 ${(size / 1048576).toFixed(0)}MB / 약 136MB (처음 한 번만)` });
self.fetch = async (input, options) => {
  const response = await originalFetch(input, options);
  if (!modelUrl(input)) return response;
  let last = 0;
  return sizedModelResponse(response, size => { if (size - last >= 2097152) { last = size; reportBytes(size); } });
};
const cache = typeof caches === 'undefined' ? Promise.resolve(null) : caches.open('transformers-cache').catch(() => null);
env.useCustomCache = true;
env.customCache = {
  async match(request) {
    const store = await cache; if (!store || !modelUrl(request)) return undefined;
    const response = await store.match(request);
    if (!response) return undefined;
    const sized = await sizedModelResponse(response);
    if (sized !== response) await store.put(request, sized.clone()).catch(() => {});
    return sized;
  },
  async put(request, response) { const store = await cache; if (store && modelUrl(request)) await store.put(request, response).catch(() => {}); },
};

function load() {
  const loaded = new Map();
  return pipeline('automatic-speech-recognition', MODEL, {
    dtype: { encoder_model: 'fp32', decoder_model_merged: 'q8' }, device: 'wasm',
    progress_callback: progress => {
      if (progress.status !== 'progress' || !progress.total) return;
      loaded.set(progress.file, progress.loaded);
      const size = [...loaded.values()].reduce((sum, value) => sum + value, 0);
      self.postMessage({ phase: 'loading', progress: `음성인식 모델 준비 중 ${(size / 1048576).toFixed(0)}MB / 약 136MB (처음 한 번만 내려받고 이 기기에 저장)` });
    },
  });
}

self.onmessage = async event => {
  const { audio, language } = event.data;
  try {
    transcriber ||= load();
    const model = await transcriber;
    self.postMessage({ phase: 'recognizing', progress: language === 'ko' ? '“N번” 안내 듣는 중' : '영어 대화 받아쓰는 중' });
    const options = { return_timestamps: true, language, task: 'transcribe' };
    // Korean windows are short instructions; this stops Whisper's repetition loops.
    if (language === 'ko') Object.assign(options, { no_repeat_ngram_size: 3, max_new_tokens: 160 });
    const output = await model(audio, options);
    const duration = audio.length / 16000;
    const segments = (output.chunks || [])
      .map(chunk => ({ text: chunk.text.trim(), start: Math.max(0, chunk.timestamp?.[0] ?? 0), end: Math.min(duration, chunk.timestamp?.[1] ?? duration) }))
      .filter(segment => segment.text && Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.start < duration);
    self.postMessage({ segments, duration });
  } catch (error) {
    console.error('Whisper runtime:', error);
    transcriber = null;
    self.postMessage({ error: '이 기기에서 음성인식 모델을 실행하지 못했습니다. 인터넷 연결(모델 다운로드)과 브라우저 메모리를 확인한 뒤 다시 분석하세요. 완료된 구간은 유지됩니다.' });
  }
};
