import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';

env.allowLocalModels = false;
env.backends.onnx.wasm.numThreads = 1;
const transcribers = new Map();
const progressByFile = new Map();
self.onmessage = async event => {
  try {
    const name = event.data.repair ? 'Xenova/whisper-tiny.en' : 'onnx-community/whisper-base_timestamped';
    if (!transcribers.has(name)) transcribers.set(name, pipeline('automatic-speech-recognition', name, {
      dtype: 'q8', device: 'wasm',
      progress_callback: progress => {
        const percent = Math.round(progress.progress || 0), file = progress.file || '';
        if (progress.status === 'progress' && progressByFile.get(file) !== percent) {
          progressByFile.set(file, percent);
          self.postMessage({ progress: `음성인식 모델 준비 중 ${Math.round(progress.progress || 0)}% · 최초 다운로드 후 이 기기에 캐시됩니다.` });
        }
      },
    }));
    const model = await transcribers.get(name);
    self.postMessage({ progress: 'Whisper로 음성인식 중… 기기 성능에 따라 시간이 걸립니다.' });
    const output = await model(event.data.audio, event.data.repair ? { return_timestamps: 'word' } : { return_timestamps: 'word', language: 'en', task: 'transcribe' });
    const duration = event.data.audio.length / 16000;
    const words = (output.chunks || []).filter(chunk => chunk.timestamp?.every(Number.isFinite)).map(chunk => ({ text: chunk.text.trim(), start: Math.max(0, chunk.timestamp[0]), end: Math.min(duration, chunk.timestamp[1]) })).filter(word => word.text && word.end - word.start > .01 && word.start < duration);
    self.postMessage({ words, duration });
  } catch (error) {
    console.error('Whisper runtime:', error.message);
    transcribers.clear();
    self.postMessage({ error: '기기 내 음성인식 모델을 실행하지 못했습니다. 모델 다운로드 연결과 브라우저 메모리를 확인하거나 Google 음성인식 방식을 선택하세요.' });
  }
};
