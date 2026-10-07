import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

export async function verifyDeployment(origin, revision = Date.now().toString()) {
  const base = new URL(origin);
  async function request(path, options = {}) {
    const url = new URL(path, base);
    url.searchParams.set('deployment-check', revision);
    return fetch(url, { ...options, cache: 'no-store', signal: AbortSignal.timeout(20000) });
  }

  const teacher = await request('/teacher');
  assert.equal(teacher.status, 200, 'Teacher page is unavailable');
  const html = await teacher.text();
  assert.match(html, /id="pastExamCard"/, 'Teacher page still has the old UI');
  assert.match(html, /id="importExamBtn"/, 'Import button is missing');
  const modulePath = html.match(/<script\b[^>]*\bsrc="([^"]*teacher\.js[^\"]*)"/i)?.[1];
  assert.ok(modulePath, 'Teacher module is missing');

  const moduleResponse = await request(modulePath);
  assert.equal(moduleResponse.status, 200, 'Teacher module is unavailable');
  const moduleText = await moduleResponse.text();
  assert.match(moduleText, /initPastExamImport/, 'Teacher module still has the old code');
  const importPath = moduleText.match(/from\s*["']([^"']*auto-import\.js[^"']*)["']/)?.[1];
  assert.ok(importPath, 'Import module is not connected');
  const importer = await request(importPath);
  assert.equal(importer.status, 200, 'Import module is unavailable');
  assert.match(await importer.text(), /\/api\/past-exam/, 'Import API is not connected');

  // Invalid selectors reach our function but never download, translate, or save data.
  const api = await request('/api/past-exam/prepare', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ year: 2000, grade: '중1', session: 1 }),
  });
  assert.equal(api.status, 422, 'Import API rewrite or function is unavailable');
  assert.match(api.headers.get('content-type') || '', /application\/json/);
  const result = await api.json();
  assert.match(result.error || '', /2017/, 'Import API did not run selector validation');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const origin = process.env.DEPLOYMENT_URL || 'https://listening-7680f.web.app';
  for (let attempt = 1; ; attempt += 1) {
    try {
      await verifyDeployment(origin, process.env.GITHUB_SHA);
      console.log('Live teacher UI, JavaScript modules, and import API verified.');
      break;
    } catch (error) {
      if (attempt >= 5) throw error;
      console.warn(`Deployment check ${attempt}/5 failed: ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}
