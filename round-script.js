import { getQuestionGroupLabel, getQuestionGroupRanges } from './question-groups.js';

export function parseQuestions(text, { allowEnglishOnly = false } = {}) {
  const lines = text.replace(/\r/g, '').split('\n'), out = []; let current = null;
  const numberRe = /^\s*(?:문제\s*)?(?:\[(\d{1,3})\]|(\d{1,3})\s*번|(\d{1,3})\s*[.)])\s*$/;
  const finish = () => { if (current?.rows.length) out.push({ ...current, text: current.rows.map(row => `${row.english}\t${row.korean}`).join('\n') }); };
  for (const line of lines) {
    const match = line.match(numberRe);
    if (match) { finish(); current = { number: Number(match[1] || match[2] || match[3]), rows: [] }; continue; }
    if (!current || !line.trim()) continue;
    const tab = line.indexOf('\t');
    if (tab < 0 && !allowEnglishOnly) continue;
    const english = (tab < 0 ? line : line.slice(0, tab)).trim(), korean = tab < 0 ? '' : line.slice(tab + 1).trim();
    if (english && (korean || allowEnglishOnly)) current.rows.push({ english, korean });
  }
  finish(); return out;
}

export function buildGroups(questions) {
  return getQuestionGroupRanges(questions).map((_, index) => ({ index, label: getQuestionGroupLabel(questions, index), audioUrl: '', audioPath: '', segmentStart: '', segmentEnd: '' }));
}

export function importedScriptText(questions) {
  return questions.map(q => `${q.number}번\n${q.rows.map(row => `${row.english}\t${row.korean}`).join('\n')}`).join('\n\n');
}
