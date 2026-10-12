const fs = require("node:fs/promises");

async function loadTimedLyrics(filePath, duration, offset = 0) {
  return { path: filePath, ...timedLyricsFromText(await fs.readFile(filePath, "utf8"), duration, offset) };
}

function timedLyricsFromText(content, duration, offset = 0) {
  const allCues = parseTimedLyrics(content);
  const usesFullSongTime = offset > 0.5 && allCues.some((cue) => cue.end > offset && cue.start < offset + duration);
  const cues = clampCues(
    usesFullSongTime
      ? allCues.map((cue) => ({ ...cue, start: cue.start - offset, end: cue.end - offset }))
      : allCues,
    duration
  );
  if (!cues.length) throw new Error("The lyrics file has no readable LRC or SRT timestamps.");
  return {
    language: "provided",
    languageProbability: 1,
    segments: cues.map(cueToSegment)
  };
}

function parseTimedLyrics(content, duration = Infinity) {
  const source = String(content).replace(/^\uFEFF/, "");
  const srt = parseSrt(source);
  if (srt.length) return clampCues(srt, duration);
  return clampCues(parseLrc(source, duration), duration);
}

function parseLrc(content, duration) {
  const lines = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const tags = [...rawLine.matchAll(/\[(\d{1,3}):(\d{2}(?:\.\d{1,3})?)\]/g)];
    const text = rawLine.replace(/\[[^\]]+\]/g, "").trim();
    if (!text) continue;
    for (const tag of tags) lines.push({ start: Number(tag[1]) * 60 + Number(tag[2]), text });
  }
  lines.sort((a, b) => a.start - b.start);
  return lines.map((line, index) => ({
    ...line,
    end: Math.max(line.start + 0.3, lines[index + 1]?.start ?? Math.min(duration, line.start + 3.5))
  }));
}

function parseSrt(content) {
  const cues = [];
  for (const block of content.trim().split(/\r?\n\s*\r?\n/)) {
    const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) continue;
    const match = lines[timingIndex].match(/(.+?)\s*-->\s*(.+)/);
    const start = parseTimestamp(match?.[1]);
    const end = parseTimestamp(match?.[2]);
    const text = lines.slice(timingIndex + 1).join(" ").replace(/<[^>]+>/g, "").trim();
    if (Number.isFinite(start) && Number.isFinite(end) && end > start && text) cues.push({ start, end, text });
  }
  return cues;
}

function parseTimestamp(value) {
  const match = String(value || "").trim().match(/(?:(\d+):)?(\d{1,2}):(\d{2}(?:[.,]\d{1,3})?)/);
  if (!match) return NaN;
  return Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3].replace(",", "."));
}

function clampCues(cues, duration) {
  return cues
    .filter((cue) => cue.start < duration && cue.end > 0)
    .map((cue) => ({ ...cue, start: Math.max(0, cue.start), end: Math.min(duration, cue.end) }))
    .filter((cue) => cue.end > cue.start)
    .sort((a, b) => a.start - b.start);
}

function cueToSegment(cue) {
  const tokens = cue.text.split(/\s+/).filter(Boolean);
  const span = Math.max(0.08, (cue.end - cue.start) / Math.max(1, tokens.length));
  return {
    text: cue.text,
    start: cue.start,
    end: cue.end,
    noSpeechProbability: 0,
    words: tokens.map((text, index) => ({
      text,
      start: cue.start + span * index,
      end: Math.min(cue.end, cue.start + span * (index + 1)),
      probability: 1
    }))
  };
}


// Replace Whisper's (often misspelled) words with user-provided plain lyrics
// while keeping Whisper's timing. The heard words are aligned against any part
// of the lyric text (semi-global alignment), so the full song text can be
// pasted even when the montage only uses one chorus.
function alignPlainLyrics(transcript, plainText) {
  const heard = (transcript?.segments || []).flatMap((segment) => segment.words || []);
  const lyrics = tokenizeLyrics(plainText);
  if (!heard.length || !lyrics.length) return transcript;
  const rows = heard.length;
  const cols = lyrics.length;
  const SKIP_HEARD = -0.45;
  const SKIP_LYRIC = -0.55;
  const score = Array.from({ length: rows + 1 }, () => new Float64Array(cols + 1));
  const move = Array.from({ length: rows + 1 }, () => new Uint8Array(cols + 1));
  for (let i = 1; i <= rows; i += 1) { score[i][0] = i * SKIP_HEARD; move[i][0] = 2; }
  // Row 0 stays zero: skipping lyric words before the heard section is free.
  const heardNorm = heard.map((word) => normalizeWord(word.text));
  const lyricNorm = lyrics.map((word) => normalizeWord(word.text));
  for (let i = 1; i <= rows; i += 1) {
    for (let j = 1; j <= cols; j += 1) {
      const similarity = wordSimilarity(heardNorm[i - 1], lyricNorm[j - 1]);
      const diagonal = score[i - 1][j - 1] + (similarity >= 0.5 ? similarity * 2 - 0.6 : -0.9);
      const up = score[i - 1][j] + SKIP_HEARD;
      const left = score[i][j - 1] + SKIP_LYRIC;
      if (diagonal >= up && diagonal >= left) { score[i][j] = diagonal; move[i][j] = 1; }
      else if (up >= left) { score[i][j] = up; move[i][j] = 2; }
      else { score[i][j] = left; move[i][j] = 3; }
    }
  }
  let endColumn = 1;
  for (let j = 1; j <= cols; j += 1) if (score[rows][j] > score[rows][endColumn]) endColumn = j;
  const pairs = [];
  for (let i = rows, j = endColumn; i > 0 && j > 0;) {
    if (move[i][j] === 1) { pairs.push({ heard: i - 1, lyric: j - 1, similarity: wordSimilarity(heardNorm[i - 1], lyricNorm[j - 1]) }); i -= 1; j -= 1; }
    else if (move[i][j] === 2) i -= 1;
    else j -= 1;
  }
  pairs.reverse();
  const confident = pairs.filter((pair) => pair.similarity >= 0.5);
  if (confident.length < Math.max(2, heard.length * 0.35)) return transcript;

  const firstLyric = confident[0].lyric;
  const lastLyric = confident.at(-1).lyric;
  const timed = new Map(pairs.map((pair) => [pair.lyric, heard[pair.heard]]));
  const words = [];
  for (let j = firstLyric; j <= lastLyric; j += 1) {
    const match = timed.get(j);
    if (match) {
      words.push({ text: lyrics[j].text, start: match.start, end: match.end, probability: 1, line: lyrics[j].line });
      continue;
    }
    // Lyric word Whisper did not hear: share the gap between its neighbours.
    let previous = j - 1;
    while (previous >= firstLyric && !timed.has(previous)) previous -= 1;
    let next = j + 1;
    while (next <= lastLyric && !timed.has(next)) next += 1;
    const from = timed.get(previous)?.end ?? timed.get(next)?.start ?? 0;
    const to = timed.get(next)?.start ?? from + 0.3;
    const slots = next - previous;
    const position = j - previous;
    const start = from + ((to - from) * (position - 1)) / Math.max(1, slots - 1);
    const end = from + ((to - from) * position) / Math.max(1, slots - 1);
    words.push({ text: lyrics[j].text, start, end: Math.max(start + 0.05, end), probability: 0.8, line: lyrics[j].line });
  }
  const lines = new Map();
  for (const word of words) {
    if (!lines.has(word.line)) lines.set(word.line, []);
    lines.get(word.line).push(word);
  }
  return {
    ...transcript,
    lyricsAligned: true,
    segments: [...lines.values()].map((lineWords) => ({
      text: lineWords.map((word) => word.text).join(" "),
      start: lineWords[0].start,
      end: lineWords.at(-1).end,
      noSpeechProbability: 0,
      words: lineWords.map(({ line, ...word }) => word)
    }))
  };
}

function tokenizeLyrics(plainText) {
  return String(plainText || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\[[^\]]*\]/g, " ").replace(/\([^)]*\)/g, (part) => part.slice(1, -1)).trim())
    .filter(Boolean)
    .flatMap((line, lineIndex) => line.split(/\s+/).filter((token) => normalizeWord(token)).map((text) => ({ text, line: lineIndex })));
}

function normalizeWord(value) {
  return String(value || "").toLowerCase()
    .replaceAll("ä", "ae").replaceAll("ö", "oe").replaceAll("ü", "ue").replaceAll("ß", "ss")
    .normalize("NFKD").replace(/[^\p{L}\p{N}]/gu, "");
}

function wordSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const saved = previous[j];
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = saved;
    }
  }
  return 1 - previous[b.length] / Math.max(a.length, b.length);
}

function looksTimed(text) {
  return /\[\d{1,3}:\d{2}/.test(text) || /-->/.test(text);
}

module.exports = { loadTimedLyrics, timedLyricsFromText, parseTimedLyrics, parseTimestamp, alignPlainLyrics, tokenizeLyrics, wordSimilarity, looksTimed, cueToSegment, clampCues };
