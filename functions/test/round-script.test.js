import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Browser modules are ESM; load their exact sources without adding a root Node package.
const groupSource = readFileSync(new URL('../../question-groups.js', import.meta.url), 'utf8');
const groupsUrl = `data:text/javascript;base64,${Buffer.from(groupSource).toString('base64')}`;
const source = readFileSync(new URL('../../round-script.js', import.meta.url), 'utf8').replace("'./question-groups.js'", JSON.stringify(groupsUrl));
const { parseQuestions, buildGroups, importedScriptText } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('manual Tab parser retains original strict behavior and numbering forms', () => {
  const questions = parseQuestions('header\n1번\nHello.\t안녕.\nEnglish only\nNo Korean\t\n[2]\nThank you.\t고맙습니다.\n3)\nGoodbye.\t잘 가.\n4.\nYes.\t네.');
  assert.deepEqual(questions.map(q => q.number), [1, 2, 3, 4]);
  assert.equal(questions[0].rows.length, 1); assert.equal(questions[0].text, 'Hello.\t안녕.');
});
test('English-only imports survive preview, round save and round edit', () => {
  const original = [{ number: 1, rows: [{ english: 'M: Hello.', korean: '' }, { english: 'W: Hi.', korean: '안녕.' }] }];
  const questions = parseQuestions(importedScriptText(original), { allowEnglishOnly: true });
  assert.deepEqual(questions[0].rows, original[0].rows);
  assert.equal(parseQuestions('1번\nHello.').length, 0);
});
test('existing grouping including 16/17 questions stays unchanged', () => {
  for (const [count, sizes] of [[16, [3, 3, 3, 3, 4]], [17, [3, 3, 3, 3, 3, 2]], [20, [4, 4, 4, 4, 4]]]) {
    const questions = Array.from({ length: count }, (_, i) => ({ number: i + 1 }));
    const groups = buildGroups(questions);
    assert.equal(groups.length, sizes.length);
    assert.deepEqual(groups.map(group => group.label), sizes.map((size, i) => {
      const first = sizes.slice(0, i).reduce((a, b) => a + b, 0) + 1;
      return `${first}-${first + size - 1}번`;
    }));
    assert.ok(groups.every(group => group.audioUrl === '' && group.segmentStart === ''));
  }
});

test('Hosting excludes backend code and CI-generated service account credentials', () => {
  const config = JSON.parse(readFileSync(new URL('../../firebase.json', import.meta.url), 'utf8'));
  for (const hosting of config.hosting) {
    assert.ok(hosting.ignore.includes('functions/**'));
    assert.ok(hosting.ignore.includes('gha-creds-*.json'));
  }
});
