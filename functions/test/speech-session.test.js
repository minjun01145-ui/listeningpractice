import test from 'node:test';
import assert from 'node:assert/strict';
import { runSpeechWorker } from '../../speech-session.js';
import { sizedModelResponse } from '../../speech-download.js';
class WorkerFixture {
  terminate() { this.terminated = true; }
  postMessage(payload) { this.payload = payload; this.start?.(); }
  send(data) { this.onmessage?.({ data }); }
}
const options = { progress() {}, loadingIdleMs: 30, inferenceMs: 20, tickMs: 2 };
test('a stalled model download terminates instead of waiting forever', async () => {
  const worker = new WorkerFixture();
  await assert.rejects(runSpeechWorker(worker, new Float32Array(2), options), /다운로드가 멈췄습니다/);
  assert.equal(worker.terminated, true); assert.equal(worker.onmessage, null);
});
test('a stuck recognition times out while the page is visible', async () => {
  const worker = new WorkerFixture();
  worker.start = () => worker.send({ phase: 'recognizing', progress: '인식 중' });
  await assert.rejects(runSpeechWorker(worker, new Float32Array(2), options), /응답하지 않아/);
  assert.equal(worker.terminated, true);
});
test('time in a hidden (background) tab never cancels the analysis', async () => {
  const worker = new WorkerFixture(); let hidden = true;
  worker.start = () => worker.send({ phase: 'recognizing', progress: '인식 중' });
  const pending = runSpeechWorker(worker, new Float32Array(2), { ...options, isHidden: () => hidden });
  await new Promise(resolve => setTimeout(resolve, 60));
  hidden = false; worker.send({ segments: [{ text: 'hello', start: 0, end: 1 }], duration: 1 });
  assert.equal((await pending).segments[0].text, 'hello');
  assert.equal(worker.terminated, undefined);
});
test('cancellation terminates, success detaches handlers and sends the language', async () => {
  const worker = new WorkerFixture(), controller = new AbortController();
  const pending = runSpeechWorker(worker, new Float32Array(2), { ...options, signal: controller.signal });
  controller.abort(); await assert.rejects(pending, /중지/); assert.equal(worker.terminated, true);
  const next = new WorkerFixture(); next.start = () => next.send({ segments: [{ text: '7번', start: 0, end: 1 }], duration: 1 });
  const result = await runSpeechWorker(next, new Float32Array(2), { ...options, language: 'ko' });
  assert.equal(next.payload.language, 'ko');
  assert.equal(result.segments[0].text, '7번'); assert.equal(next.terminated, undefined); assert.equal(next.onmessage, null);
});
test('model responses without Content-Length are gathered once with their real size', async () => {
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1, 2])); controller.enqueue(new Uint8Array([3])); controller.close(); } });
  const sized = await sizedModelResponse(new Response(body));
  assert.equal(sized.headers.get('content-length'), '3');
  assert.deepEqual([...new Uint8Array(await sized.arrayBuffer())], [1, 2, 3]);
});
