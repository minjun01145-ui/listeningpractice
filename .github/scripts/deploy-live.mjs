import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

export function isCleanupOnlyFailure(result) {
  const output = result.output.replace(/\u001b\[[0-9;]*m/g, '');
  return result.code === 1 && (output.match(/\bError:/g) || []).length === 1 && /Error: Functions successfully deployed but could not set up cleanup policy in location asia-northeast3\. Pass the --force option to automatically set up a cleanup policy or run 'firebase functions:artifacts:setpolicy' to manually set up a cleanup policy\.\s*$/.test(output);
}

function runFirebase(target) {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['--yes', 'firebase-tools@15.27.0', 'deploy', '--only', target, '--project', 'listening-7680f', '--non-interactive'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' } });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output += data; process.stdout.write(data); });
    child.on('error', reject);
    child.on('close', code => resolve({ code, output }));
  });
}

export async function verifyRevision(revision) {
  let lastError;
  for (let i = 0; i < 10; i++) {
    try {
      const response = await fetch('https://listening-7680f.web.app/api/past-exam/release', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', cache: 'no-store', signal: AbortSignal.timeout(20000) });
      assert.equal(response.status, 200, 'Function release endpoint is unavailable');
      assert.equal((await response.json()).revision, revision, 'Function has a different deployed commit');
      return;
    } catch (error) { lastError = error; if (i < 9) await new Promise(resolve => setTimeout(resolve, 3000)); }
  }
  throw lastError;
}

export async function deployLive(targets, { run = runFirebase, verify = verifyRevision, revision = process.env.GITHUB_SHA || 'local' } = {}) {
  const allowed = ['hosting:listeningpractice', 'functions:past-exam,hosting:listeningpractice'];
  assert.ok(allowed.includes(targets), 'Unsupported live deployment targets');
  if (targets.includes('functions:past-exam')) {
    const result = await run('functions:past-exam');
    if (result.code !== 0 && !isCleanupOnlyFailure(result)) throw new Error(`Functions deployment failed (exit ${result.code})`);
    // Missing image-retention settings must not skip checking the actual new server.
    // Keep images intact; never use --force or change Artifact Registry policies.
    await verify(revision);
    if (result.code !== 0) console.warn('Function commit verified. Artifact images remain retained; cleanup policy was not changed.');
  }
  const hosting = await run('hosting:listeningpractice');
  if (hosting.code !== 0) throw new Error(`Hosting deployment failed (exit ${hosting.code})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const revision = process.env.GITHUB_SHA;
  assert.match(revision || '', /^[a-f0-9]{40}$/, 'CI commit revision is required');
  await writeFile(new URL('../../functions/release-revision.js', import.meta.url), `export const RELEASE_REVISION = ${JSON.stringify(revision)};\n`);
  await deployLive(process.env.DEPLOY_TARGETS);
}
