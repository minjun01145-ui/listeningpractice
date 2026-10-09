import test from 'node:test';
import assert from 'node:assert/strict';
import { deployLive, isCleanupOnlyFailure } from './deploy-live.mjs';

const cleanup = {code:1,output:"Function update completed.\nError: Functions successfully deployed but could not set up cleanup policy in location asia-northeast3. Pass the --force option to automatically set up a cleanup policy or run 'firebase functions:artifacts:setpolicy' to manually set up a cleanup policy.\n"};
test('only the precise post-deployment cleanup warning can be tolerated', () => {
  assert.equal(isCleanupOnlyFailure(cleanup), true);
  for (const result of [{code:2,output:cleanup.output},{code:1,output:'Error: Missing deployment permissions'},{code:1,output:'Error: Build failed\n'+cleanup.output},{code:1,output:cleanup.output+'Error: Unrelated failure'}]) assert.equal(isCleanupOnlyFailure(result), false);
});
test('verifies the deployed function commit before releasing Hosting', async () => {
  const calls = [];
  await deployLive('functions:past-exam,hosting:listeningpractice', {revision:'expected',run:async target=>{calls.push(target);return target.startsWith('functions')?cleanup:{code:0,output:''};},verify:async revision=>calls.push(`verify:${revision}`)});
  assert.deepEqual(calls, ['functions:past-exam','verify:expected','hosting:listeningpractice']);
});
test('a failed build or mismatched server prevents Hosting release', async () => {
  for (const failure of ['build','revision']) {
    const calls = [];
    await assert.rejects(deployLive('functions:past-exam,hosting:listeningpractice', {run:async target=>{calls.push(target);return failure==='build'?{code:1,output:'Error: Build failed'}:cleanup;},verify:async()=>{throw new Error('Old commit');}}));
    assert.deepEqual(calls, ['functions:past-exam']);
  }
});
test('UI-only releases deploy Hosting without changing or requiring a function commit', async () => {
  const calls = [];
  await deployLive('hosting:listeningpractice',{run:async target=>{calls.push(target);return {code:0,output:''};},verify:async()=>{throw new Error('Should not call');}});
  assert.deepEqual(calls, ['hosting:listeningpractice']);
});
