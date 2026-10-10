// Pure timing logic shared by the browser analyzer and Node tests. Times are seconds.
// Question starts are found from real speech only: Whisper segments are aligned to
// the official script, then the spoken "N번" instruction before each dialogue is
// located. Nothing here estimates a start time that was not heard in the audio.

const FRAME = 0.05;
const KOREAN_DIGITS = ['', '일', '이', '삼', '사', '오', '육', '칠', '팔', '구'];
const ENGLISH_NUMBERS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
const ORDINALS = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth', 'eighteenth', 'nineteenth', 'twentieth'];

export function koreanNumber(n) {
  if (n < 10) return KOREAN_DIGITS[n];
  return `${n >= 20 ? KOREAN_DIGITS[Math.floor(n / 10)] : ''}십${KOREAN_DIGITS[n % 10]}`;
}

export function energyProfile(samples, sampleRate = 16000) {
  const size = Math.round(sampleRate * FRAME), db = new Float32Array(Math.floor(samples.length / size));
  for (let f = 0; f < db.length; f++) {
    let sum = 0;
    for (let i = f * size, end = i + size; i < end; i++) sum += samples[i] * samples[i];
    db[f] = 10 * Math.log10(sum / size + 1e-12);
  }
  return { db, frame: FRAME, duration: samples.length / sampleRate };
}

function speechThreshold(db) {
  const sorted = Float32Array.from(db).sort(), floor = sorted[Math.floor(sorted.length * 0.1)] ?? -120, peak = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
  return Math.max(floor + 12, peak - 35);
}

// Speech onsets with the length of the quiet run before each one.
export function speechOnsets({ db, frame }) {
  const threshold = speechThreshold(db), onsets = [];
  let quiet = 0;
  for (let f = 0; f < db.length; f++) {
    if (db[f] < threshold) { quiet++; continue; }
    if (quiet * frame >= 0.3) onsets.push({ time: f * frame, gap: quiet * frame });
    quiet = 0;
  }
  return onsets;
}

// Middle of the quietest 0.3 s inside [from, to].
export function quietestPoint({ db, frame }, from, to) {
  let best = Infinity, bestFrame = Math.floor(from / frame);
  const width = 6;
  for (let f = Math.floor(from / frame); f <= Math.floor(to / frame) - width; f++) {
    let loudest = -Infinity;
    for (let k = f; k < f + width; k++) loudest = Math.max(loudest, db[k] ?? -120);
    if (loudest < best) { best = loudest; bestFrame = f; }
  }
  return (bestFrame + width / 2) * frame;
}

// Cut chunks at the quietest point so Whisper never sees a word split in half.
export function chunkPlan(profile, maxLength = 29.5, minLength = 22) {
  const chunks = [], { duration } = profile;
  for (let start = 0; start < duration - 0.3;) {
    const end = start + maxLength >= duration ? duration : quietestPoint(profile, start + minLength, start + maxLength);
    chunks.push({ start, end });
    start = end;
  }
  return chunks;
}

// Whisper sometimes loops ("英語 英語 …") or stretches one short line over a long
// stretch of speech; such a chunk is transcribed again in smaller pieces.
export function badTranscript(segments) {
  return segments.some(segment => {
    const words = String(segment.text).toLowerCase().split(/\s+/).filter(Boolean);
    const grams = new Map();
    for (let i = 0; i + 3 <= words.length; i++) { const key = words.slice(i, i + 3).join(' '); grams.set(key, (grams.get(key) || 0) + 1); }
    return /[぀-ヿ一-鿿]/.test(segment.text) || Math.max(0, ...grams.values()) >= 3 || (segment.end - segment.start > 20 && segment.text.length < 80);
  });
}

// Stretches of sound (at least minLength seconds, short pauses allowed) that no
// recognized segment covers: Whisper skipped them, so they are tried again.
export function uncoveredSpeech({ db, frame }, segments, from, to, minLength = 6) {
  // A sound label covers its music; a few words stretched over 10 s ("4.") do not.
  const covered = segment => annotation(segment.text) || segment.end - segment.start < 4 || String(segment.text).length >= (segment.end - segment.start) * 2;
  const threshold = speechThreshold(db);
  const spans = segments.filter(covered), gaps = [];
  let run = null, quiet = 0;
  for (let f = Math.floor(from / frame); f < Math.min(db.length, Math.floor(to / frame)); f++) {
    const time = f * frame, loud = db[f] >= threshold && !spans.some(segment => time >= segment.start - 0.3 && time <= segment.end + 0.3);
    if (loud) { run ||= { start: time, end: time }; run.end = time + frame; quiet = 0; continue; }
    if (run && ++quiet * frame > 0.8) { if (run.end - run.start >= minLength) gaps.push(run); run = null; }
  }
  if (run && run.end - run.start >= minLength) gaps.push(run);
  return gaps;
}

const tokens = text => String(text).toLowerCase().replace(/[’']/g, '').match(/[a-z0-9]+/g) || [];
export const englishScript = question => question.rows
  .map(row => String(row.english || '').replace(/\[[^\]]*\]/g, ' ').replace(/^\s*(?:[MWBF]|[A-Z][a-z]+)\s*:\s*/, ''))
  .join(' ').trim();
// Sound labels such as "[music]" or "(Cellphone rings.)" are not speech.
const spoken = text => String(text).replace(/\[[^\]]*\]?|\([^)]*\)?|[♪*]/g, ' ');
export const annotation = text => !/[a-z0-9가-힣]/i.test(spoken(text));

function lcs(a, b) {
  const dp = new Uint16Array(b.length + 1);
  for (const x of a) {
    let previous = 0;
    for (let j = 1; j <= b.length; j++) {
      const saved = dp[j];
      dp[j] = x === b[j - 1] ? previous + 1 : Math.max(dp[j], dp[j - 1]);
      previous = saved;
    }
  }
  return dp[b.length];
}

// Mark questions that reuse the previous passage (e.g. 고1 16·17번).
export function sharedPassages(questions) {
  return questions.map((question, index) => {
    const previous = questions[index - 1];
    return Boolean(previous && (question.sharedWith === previous.number || englishScript(question) === englishScript(previous)));
  });
}

// Global monotonic alignment: one weak match cannot push later questions off.
export function alignQuestions(questions, segments) {
  const words = [];
  segments.forEach((segment, index) => {
    if (annotation(segment.text) || (cueNumber(segment.text) && segment.text.trim().length <= 8)) return;
    const list = tokens(spoken(segment.text));
    list.forEach((word, k) => words.push({ word, segment: index, first: k === 0, time: segment.start + (segment.end - segment.start) * k / Math.max(1, list.length) }));
  });
  const shared = sharedPassages(questions);
  const candidates = questions.map((question, q) => {
    if (shared[q]) return [];
    const script = tokens(englishScript(question)).slice(0, 24);
    if (script.length < 3) return [];
    const list = [];
    for (let i = 0; i < words.length; i++) {
      if (!words[i].first) continue;
      const window = [], opening = [];
      for (let j = i; j < words.length && window.length < script.length + 8 && words[j].time - words[i].time < 45; j++) {
        window.push(words[j].word);
        if (words[j].segment === words[i].segment) opening.push(words[j].word);
      }
      const matched = lcs(script, window);
      if (matched / script.length < 0.45) continue;
      // The candidate's own first sentence must belong to the script's opening;
      // otherwise it is the tail of the previous dialogue ("Thanks.", "Let's go.").
      // Whisper may drop the first script sentence, so the opening allows ~16 words.
      if (lcs(script.slice(0, 16), opening) < Math.max(1, opening.length * 0.5)) continue;
      const score = matched / script.length;
      // Rank by how well the first sentence matches the script's very beginning,
      // so the real start outranks a short decoy that shares a word ("Thank you.").
      const lead = lcs(script.slice(0, opening.length + 4), opening) / Math.max(1, opening.length);
      list.push({ time: segments[words[i].segment].start, segment: words[i].segment, score, rank: score + 0.3 * lead });
    }
    return list;
  });
  // best[q][c] = best total score of an in-order path ending with candidate c of
  // question q. Any earlier question (or none) may precede it, so missing ones are skipped.
  const best = candidates.map(list => list.map(() => ({ total: -Infinity, previous: null })));
  let top = null;
  for (let q = 0; q < questions.length; q++) {
    candidates[q].forEach((candidate, c) => {
      let chosen = { total: candidate.rank, previous: null };
      for (let p = 0; p < q; p++) candidates[p].forEach((earlier, e) => {
        if (earlier.time > candidate.time - 4) return;
        const total = best[p][e].total + candidate.rank;
        if (total > chosen.total + 1e-9) chosen = { total, previous: { q: p, c: e } };
      });
      best[q][c] = chosen;
      // Strict comparison keeps the earliest play of a repeated passage.
      if (!top || chosen.total > top.total + 1e-9) top = { total: chosen.total, q, c };
    });
  }
  const result = questions.map(question => ({ number: question.number, englishStart: null, segment: null, score: 0 }));
  for (let node = top && { q: top.q, c: top.c }; node; node = best[node.q][node.c].previous) {
    const candidate = candidates[node.q][node.c];
    Object.assign(result[node.q], { englishStart: candidate.time, segment: candidate.segment, score: candidate.score });
  }
  questions.forEach((question, q) => { if (shared[q]) Object.assign(result[q], { ...result[q - 1], number: question.number, sharedWith: questions[q - 1].number }); });
  return result;
}

// Whisper renders the spoken "N번" as "N번", "칠 번", "5.", "14th." or "Number five".
export function cueNumber(text) {
  const clean = String(text).trim().toLowerCase().replace(/^[\s"'“‘(\[-]+/, '');
  // A bare number ("5.", "14th.") or "N번"; "6 p.m. sounds good" is dialogue.
  let match = clean.match(/^(?:no\.?\s*|number\s+|question\s+)?(\d{1,2})\s*번/)
    || clean.match(/^(?:no\.?\s*|number\s+|question\s+)?(\d{1,2})\s*(?:st|nd|rd|th)?\s*[.,!:]?\s*(?:next[.,]?)?$/);
  if (match) return Number(match[1]);
  // A bare "이십반." / "칠 본" is Whisper mishearing "N번"; trusted only when it stands alone.
  match = clean.match(/^([일이삼사오육칠팔구십]{1,3})\s*번/) || clean.match(/^([일이삼사오육칠팔구십]{1,3}|\d{1,2})\s*[반본]\s*[.,!]?$/);
  if (match && /^\d+$/.test(match[1])) return Number(match[1]);
  if (match) for (let n = 1; n <= 30; n++) if (koreanNumber(n) === match[1]) return n;
  match = clean.match(/^(?:number\s+|question\s+)?([a-z]+)(?=$|[\s.,!?:])/);
  if (match) {
    const n = Math.max(ENGLISH_NUMBERS.indexOf(match[1]), ORDINALS.indexOf(match[1]));
    if (n > 0 && (clean.length <= match[0].length + 2 || /^(number|question)\s/.test(clean))) return n;
  }
  return null;
}

const INSTRUCTION = /듣고|고르시|고르세|고르십|적절|알맞|대화|담화|다음은|물음|답하/;

// "N번" cue inside [from, to]; late cues win over the opening announcement ("1번부터 17번까지").
export function findCue(segments, number, from, to) {
  // A bare "4." stretched over several seconds has a drifted timestamp; skip it.
  const stretched = segment => segment.end - segment.start > 3 && String(segment.text).trim().length <= 8;
  const found = segments.filter(segment => segment.start >= from - 0.01 && segment.start <= to + 0.01 && !stretched(segment) && cueNumber(segment.text) === number).map(segment => segment.start);
  if (!found.length) return null;
  // A group header ("19번과 20번 …") shortly before "19번" starts the question block.
  const latest = Math.max(...found);
  return Math.min(...found.filter(time => time >= latest - 12));
}

// Korean-pass fallback when the number itself was misheard: the last instruction
// sentence before the dialogue (the first could be the exam's opening announcement).
export function findInstruction(segments, from, to) {
  let found = null;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment.start < from - 0.01 || segment.start > to + 0.01 || !INSTRUCTION.test(segment.text)) continue;
    const before = segments[i - 1];
    // Keep a short number segment ("칠 번", "N.") that directly precedes the sentence.
    found = before && before.start >= from - 0.01 && segment.start - before.end < 1.5 && before.end - before.start < 3 && /d|번/.test(before.text) ? before.start : segment.start;
  }
  return found;
}

// Windows for the targeted Korean pass, tried in order until "N번" is heard.
// Whisper drops speech that follows a long silence or music inside its window
// ("[댄스]" and stop), so the first window starts at the speech after the longest
// pause: in these exams that pause precedes "N번" (after the answer time or jingle).
export function cueWindows(alignment, index, segments, onsets = [], duration = Infinity) {
  const current = alignment[index];
  const previous = alignment.slice(0, index).reverse().find(item => item.englishStart !== null && !item.sharedWith);
  const next = alignment.slice(index + 1).find(item => item.englishStart !== null && !item.sharedWith);
  const floor = previous ? previous.englishStart + 4 : 0;
  const longestPauses = (from, to, count) => onsets.filter(onset => onset.time >= from && onset.time <= to && onset.gap >= 0.8).sort((x, y) => y.gap - x.gap).slice(0, count);
  const windows = [];
  const add = (start, end, scan = false) => {
    start = Math.max(floor, start);
    if (end - start > 3 && !windows.some(window => Math.abs(window.start - start) < 2)) windows.push({ start, end: Math.min(end, start + 29, duration), scan });
  };
  if (current.englishStart === null) {
    const end = next ? next.englishStart : duration;
    for (const pause of longestPauses(floor, end - 3, 6)) add(pause.time - 0.3, pause.time + 16, true);
    return windows;
  }
  const english = current.englishStart, matched = segments[current.segment];
  // A long, slow first segment means Whisper folded the Korean instruction into it.
  const slow = matched && matched.end - matched.start > tokens(matched.text).length * 0.5 + 2;
  const end = Math.min(duration, slow ? Math.min(matched.end, english + 16) : english + 1);
  // The longest pause is usually right before "N번"; the next ones cover a jingle
  // whose pause is a little shorter than the one before it.
  for (const pause of longestPauses(Math.max(floor, english - 26), end - 1.5, 3)) add(pause.time - 0.3, end);
  let jingle = null;
  for (const segment of segments) if (annotation(segment.text) && segment.end > Math.max(floor, english - 26) && segment.end < end - 1) jingle = segment;
  if (jingle) add(jingle.end - 1.5, end);
  add(english - 16, end);
  add(english - 24, end);
  return windows.slice(0, 5);
}

// Move a heard cue to where its speech starts. After a real silence that is the
// first sound after it (Whisper's timestamp there can drift several seconds);
// otherwise the onset after the longest short pause just around the cue.
export function questionStart(time, onsets) {
  let silence = null, pause = null;
  for (const onset of onsets) {
    if (onset.gap >= 3 && onset.time >= time - 12 && onset.time <= time + 5) silence = onset;
    if (onset.time >= time - 2.5 && onset.time <= time + 1.5 && (!pause || onset.gap > pause.gap + 0.05)) pause = onset;
  }
  return (silence || pause || { time }).time;
}

export function buildTimings(questions, alignment, cues, includeInstructions = true) {
  const timings = [], warnings = [], missing = [];
  questions.forEach((question, q) => {
    const item = alignment[q], cue = cues[q];
    if (item.sharedWith) {
      const prior = timings.find(t => t.number === item.sharedWith);
      if (prior) timings.push({ number: question.number, start: prior.start, confidence: prior.confidence, sharedWith: item.sharedWith });
      else missing.push(question.number);
      return;
    }
    let start = null, confidence = Math.round(item.score * 100);
    if (includeInstructions && cue?.time != null) start = cue.time;
    else if (item.englishStart !== null) start = item.englishStart;
    else if (cue?.time != null) { start = cue.time; confidence = 60; }
    if (start === null) { missing.push(question.number); return; }
    start = Math.max(0, start - 0.3);
    const prior = timings.at(-1);
    if (prior && start <= prior.start) { missing.push(question.number); return; }
    timings.push({ number: question.number, start: Math.round(start * 10) / 10, confidence });
    if (item.englishStart === null) warnings.push(`${question.number}번: 대본과 일치하는 영어 음성을 찾지 못해 “${question.number}번” 안내 음성만으로 시간을 정했습니다. 재생해 확인하세요.`);
    else if (includeInstructions && cue?.time == null) warnings.push(`${question.number}번: “${question.number}번” 안내를 찾지 못해 영어 대화 시작 시간을 제안했습니다.`);
    else if (item.score < 0.7) warnings.push(`${question.number}번: 대본 일치도 ${Math.round(item.score * 100)}%. 재생해 확인하세요.`);
  });
  if (missing.length) warnings.push(`${missing.join('·')}번: 음원에서 위치를 확인하지 못해 비워 두었습니다. 직접 입력하세요.`);
  return { timings, warnings, missing };
}

// No "N번" heard: if a real silence (the answer time, ≥3 s) ends shortly before the
// dialogue, the first sound after it is the question's instruction.
export function silenceStart(englishStart, onsets) {
  let found = null;
  for (const onset of onsets) if (onset.gap >= 3 && onset.time >= englishStart - 15 && onset.time <= englishStart - 1) found = onset.time;
  return found;
}
