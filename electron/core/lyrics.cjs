const fs = require("node:fs/promises");

async function loadTimedLyrics(filePath, duration, offset = 0) {
  const content = await fs.readFile(filePath, "utf8");
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
    path: filePath,
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

module.exports = { loadTimedLyrics, parseTimedLyrics, parseTimestamp };
