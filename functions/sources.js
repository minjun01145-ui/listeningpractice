import { load } from 'cheerio';
import { download, officialUrl } from './download.js';

export const GRADES = {
  '중1': { ebsId: '22000010', expectedCount: 20 },
  '중2': { ebsId: '22000011', expectedCount: 20 },
  '중3': { ebsId: '22000012', expectedCount: 20 },
};
export function validateSelection(input) {
  const { year, grade, session } = input || {};
  const currentYear = Number(new Intl.DateTimeFormat('en', { year: 'numeric', timeZone: 'Asia/Seoul' }).format(new Date()));
  if (!Number.isInteger(year) || year < 2017 || year > currentYear || !GRADES[grade] || ![1, 2].includes(session)) {
    throw new Error('연도(2017년 이후), 중학교 학년, 1·2회를 올바르게 선택하세요.');
  }
  return { year, grade, session };
}

export function ebsRecord(data, selection) {
  if (!Array.isArray(data.list)) throw new Error('EBS 자료 목록 형식이 변경되었습니다.');
  const item = data.list.find(row => Number(row.year) === selection.year && String(row.round).trim() === `${selection.session}회`);
  if (!item) return null;
  return {
    name: 'EBS 중학 영어듣기능력평가',
    pageUrl: `https://mid.ebs.co.kr/english/engGrade?clsfnSystId=${GRADES[selection.grade].ebsId}`,
    scriptUrl: item.urlScrpt ? officialUrl(item.urlScrpt) : '',
    zipUrl: item.urlZip ? officialUrl(item.urlZip) : '',
    audioUrl: item.urlLstn ? officialUrl(item.urlLstn) : '',
  };
}
async function findEbs(selection) {
  const body = new URLSearchParams({ clsfnSystId: GRADES[selection.grade].ebsId, startYear: String(selection.year), endYear: String(selection.year) });
  const result = await download('https://mid.ebs.co.kr/assessment/english/innerGetDataList', {
    method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' }, limit: 1024 * 1024,
  });
  return ebsRecord(JSON.parse(result.bytes.toString('utf8')), selection);
}

const JEJU_BOARD = 'https://www.jje.go.kr/board/list.jje?boardId=BBS_0000588&menuCd=DOM_000000104001011003';
export function matchesExamTitle(title, { year, grade, session }) {
  const text = title.replace(/\s/g, '');
  return text.includes(String(year)) && text.includes('영어듣기') &&
    new RegExp(`제?${session}회`).test(text) &&
    (text.includes(grade) || text.includes(`중학교${grade.slice(1)}학년`));
}
export function jejuAttachments(html, pageUrl) {
  const $ = load(html), result = { name: '제주특별자치도교육청', pageUrl, scriptUrl: '', zipUrl: '', audioUrl: '' };
  $('a[href]').each((_, element) => {
    const anchor = $(element), text = anchor.text(), href = anchor.attr('href');
    if (!/download/i.test(href)) return;
    if (/대본.*\.pdf/i.test(text)) result.scriptUrl = officialUrl(href, pageUrl);
    if (/\.mp3/i.test(text) && !/문항별|해설/.test(text)) result.audioUrl = officialUrl(href, pageUrl);
    if (/\.zip/i.test(text)) result.zipUrl = officialUrl(href, pageUrl);
  });
  return result;
}
async function findJeju(selection) {
  const url = new URL(JEJU_BOARD);
  url.searchParams.set('paging', 'ok');
  url.searchParams.set('searchType', 'DATA_TITLE');
  // This board does not reliably accept compound keywords; search by grade,
  // then verify the year/session in titles across a bounded number of pages.
  url.searchParams.set('keyword', selection.grade);
  for (let pageNumber = 1; pageNumber <= 3; pageNumber++) {
    url.searchParams.set('startPage', String(pageNumber));
    const { bytes } = await download(url.href);
    const $ = load(bytes.toString('utf8'));
    const links = $('a[href*="view.jje"]').toArray();
    const match = links.find(element => matchesExamTitle($(element).text(), selection));
    if (match) {
      const pageUrl = officialUrl($(match).attr('href'), JEJU_BOARD);
      const page = await download(pageUrl);
      return jejuAttachments(page.bytes.toString('utf8'), pageUrl);
    }
    if (links.length < 10) break;
  }
  return null;
}

// Each adapter owns discovery; a broken site never supplies a different exam.
export const sourceProviders = [findEbs, findJeju];
export async function discover(selection, providers = sourceProviders) {
  const candidates = [], warnings = [];
  for (const provider of providers) {
    try {
      const source = await provider(selection);
      if (source && (source.scriptUrl || source.zipUrl || source.audioUrl)) {
        candidates.push(source);
        if (source.scriptUrl && source.audioUrl) break;
      }
    } catch {
      warnings.push('공식 자료 출처 중 하나에 연결하지 못했거나 자료 목록 형식이 변경되었습니다.');
    }
  }
  if (!candidates.length) throw new Error('자료를 자동으로 찾지 못했습니다. 선택한 연도·학년·회차를 확인하고 수동 등록을 이용하세요.');
  return { candidates, warnings };
}
