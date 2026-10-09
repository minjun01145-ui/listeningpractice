import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { verifyDeployment } from './verify-deployment.mjs';

async function fixture(t, failure = '') {
  const requests = [];
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    requests.push(path);
    res.setHeader('Content-Type', 'text/javascript');
    if (path === '/teacher') {
      res.setHeader('Content-Type', 'text/html');
      return res.end(failure === 'old-html' ? '<h1>Old teacher</h1>' : '<div id="pastExamCard"><button id="importExamBtn"></button><select id="importMonth"></select><input id="ollamaApiKey"></div><script type="module" src="./teacher.js?v=1"></script>');
    }
    if (path === '/teacher.js') return res.end(failure === 'old-js' ? 'export const old=true;' : 'import { initPastExamImport } from "./auto-import.js";');
    if (path === '/auto-import.js') {
      if (failure === 'missing-importer') return res.writeHead(404).end();
      return res.end('const API="/api/past-exam";');
    }
    if (path === '/audio-timing.js') return res.end('export function analyzeAudioTiming(){}');
    if (path === '/speech-worker.js') return res.end(failure === 'old-worker' ? 'old worker' : 'const model="whisper-base_timestamped";');
    if (['/api/past-exam/ollama','/api/past-exam/timings','/api/past-exam/timing-scan'].includes(path)) {
      assert.equal(req.method, 'POST');
      res.setHeader('Content-Type', 'application/json');
      return res.writeHead(422).end(JSON.stringify({error: failure === 'old-timing-api' ? '지원하지 않는 가져오기 단계입니다.' : path.endsWith('ollama') ? 'API 키를 입력하세요.' : '40분 이하 음원만 분석할 수 있습니다.'}));
    }
    if (path === '/api/past-exam/prepare') {
      let body = '';
      for await (const chunk of req) body += chunk;
      assert.equal(req.method, 'POST');
      assert.deepEqual(JSON.parse(body), { year: 2000, grade: '중1', session: 1 });
      res.setHeader('Content-Type', failure === 'html-api' ? 'text/html' : 'application/json');
      if (failure === 'missing-api') return res.writeHead(404).end('{}');
      return res.writeHead(422).end(failure === 'html-api' ? '<html>Error</html>' : JSON.stringify({ error: failure === 'wrong-handler' ? 'Other error' : '연도(2017년 이후)를 선택하세요.' }));
    }
    res.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { origin: `http://127.0.0.1:${server.address().port}`, requests };
}

test('checks live UI, its modules and a no-write API request', async t => {
  const { origin, requests } = await fixture(t);
  await verifyDeployment(origin, 'release-check');
  assert.deepEqual(requests, ['/teacher', '/teacher.js', '/auto-import.js', '/audio-timing.js', '/speech-worker.js', '/api/past-exam/prepare', '/api/past-exam/ollama', '/api/past-exam/timings', '/api/past-exam/timing-scan']);
});

for (const failure of ['old-html', 'old-js', 'missing-importer', 'missing-api', 'html-api', 'wrong-handler', 'old-worker', 'old-timing-api']) {
  test(`rejects ${failure} instead of claiming deployment succeeded`, async t => {
    const { origin } = await fixture(t, failure);
    await assert.rejects(verifyDeployment(origin), { name: 'AssertionError' });
  });
}
