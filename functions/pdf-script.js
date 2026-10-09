import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { unzipSync } from 'fflate';

export function scriptPdfFromZip(bytes) {
  // Older official ZIPs store Korean filenames as CP949 without the UTF-8 flag.
  const decodedName = name => /[^\x00-\xff]/.test(name) ? name : new TextDecoder('euc-kr').decode(Uint8Array.from(name, char => char.charCodeAt(0)));
  const files = unzipSync(new Uint8Array(bytes), {
    filter: entry => /\.pdf$/i.test(entry.name) && /대본|script/i.test(decodedName(entry.name)) && entry.originalSize < 8 * 1024 * 1024,
  });
  const entry = Object.entries(files).find(([name]) => /대본|script/i.test(decodedName(name)));
  if (!entry) throw new Error('ZIP 안에서 대본 PDF를 찾지 못했습니다.');
  return entry[1];
}

export async function extractPdfText(bytes) {
  const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, isEvalSupported: false });
  try {
    const pdf = await task.promise;
    if (pdf.numPages > 25) throw new Error('대본 PDF의 페이지 수가 너무 많습니다.');
    const pages = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber), content = await page.getTextContent();
      // Keep PDF's reading order and join wrapped items within each printed line.
      let text = '', lastY = null;
      for (const item of content.items) {
        if (!('str' in item)) continue;
        const y = item.transform[5];
        if (lastY !== null && Math.abs(lastY - y) > 3) text += '\n';
        text += item.str + (item.hasEOL ? '\n' : ' ');
        lastY = item.hasEOL ? null : y;
      }
      pages.push(text);
    }
    return pages.join('\n');
  } finally { await task.destroy(); }
}

export function parseOfficialScript(text, expectedCount = 20) {
  if (expectedCount === 17) return parseHighSchoolScript(text);
  const questions = []; let current = null;
  const normalized = text.normalize('NFKC').replace(/\r/g, '');
  for (const rawLine of normalized.split('\n')) {
    const line = rawLine.replace(/\[\s*(?:Chime|Signal|Pause)\s*\]/gi, '').replace(/\s+/g, ' ').trim();
    // Korean exam instructions mark each item; never infer question numbers from dialogue.
    const heading = line.match(/^(?:(?:문항|문제)\s*)?(\d{1,2})\s*(?:번|[.)])\s*(.*)$/);
    if (heading && Number(heading[1]) >= 1 && Number(heading[1]) <= expectedCount && (!heading[2] || /[가-힣]/.test(heading[2]))) {
      current = { number: Number(heading[1]), rows: [] }; questions.push(current); continue;
    }
    if (!current || !line || !/[A-Za-z]{2}|^[MWBF]\s*:/i.test(line)) continue;
    // Remove page headers, instructions, metadata, and repeat chimes.
    if (/[가-힣]/.test(line)) continue;
    const speaker = line.match(/^(?:[MWBF]|Man|Woman|Boy|Girl)\s*:/i);
    if (!speaker && current.rows.length) {
      current.rows.at(-1).english += ` ${line}`;
    } else { current.rows.push({ english: line, korean: '' }); }
  }
  const numbers = questions.map(q => q.number);
  if (!questions.length || questions.some(q => !q.rows.length) || numbers.some((n, i) => n !== i + 1)) {
    throw new Error('PDF 대본의 문항 구분을 확인하지 못했습니다. 원본 PDF를 확인한 뒤 대본을 수동 입력하세요.');
  }
  return questions;
}

export function parseHighSchoolScript(text) {
  const questions = []; let current = null, shared = null;
  for (const rawLine of text.normalize('NFKC').replace(/\r/g, '').split('\n')) {
    const line = rawLine.replace(/\[\s*(?:Chime|Signal|Pause)\s*\]/gi, '').replace(/\s+/g, ' ').trim();
    if (/^\[?\s*16\s*[~～〜\-–]\s*17\s*\]?/.test(line)) {
      current = { number: 16, rows: [] }; shared = current; questions.push(current); continue;
    }
    if (/^\d+\s*번부터/.test(line)) continue;
    const heading = line.match(/^(\d{1,2})\s*(?:번|[.)])\s*(.*)$/);
    if (heading && Number(heading[1]) <= 17 && /[가-힣]/.test(heading[2])) {
      const number = Number(heading[1]);
      if (shared && number >= 16) { current = null; continue; }
      current = { number, rows: [] }; questions.push(current); continue;
    }
    if (!current || !line || /[가-힣]/.test(line) || !/[A-Za-z]{2}|^[MWBF]\s*:/i.test(line)) continue;
    if (!/^(?:[MWBF]|Man|Woman|Boy|Girl|[A-Z][a-z]+)\s*:/i.test(line) && current.rows.length) current.rows.at(-1).english += ` ${line}`;
    else current.rows.push({ english: line, korean: '' });
  }
  if (shared?.rows.length) questions.push({ number: 17, rows: structuredClone(shared.rows), sharedWith: 16 });
  if (questions.length !== 17 || questions.some((q, i) => q.number !== i + 1 || !q.rows.length)) throw new Error('고1 대본의 듣기 1~17번을 확인하지 못했습니다. 원본 대본을 확인하고 수동 입력하세요.');
  return questions;
}
