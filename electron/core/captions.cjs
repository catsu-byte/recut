const path = require("node:path");

const STOP_WORDS = new Set([
  "aber", "also", "and", "auch", "auf", "das", "der", "die", "ein", "eine", "for", "für",
  "hier", "ich", "ist", "mit", "nicht", "oder", "the", "und", "von", "was", "wir", "you"
]);

function mapWordsToTimeline(plan, transcripts) {
  const byPath = new Map(transcripts.map((item) => [normalizePath(item.path), item]));
  return plan.flatMap((segment) => {
    const transcript = byPath.get(normalizePath(segment.sourcePath));
    if (!transcript) return [];
    const sourceEnd = segment.sourceStart + segment.sourceDuration;
    return transcript.segments.flatMap((part) => part.words || [])
      .filter((word) => word.end >= segment.sourceStart && word.start <= sourceEnd)
      .map((word) => ({
        text: word.text,
        probability: word.probability,
        start: clamp(segment.timelineStart + (Math.max(word.start, segment.sourceStart) - segment.sourceStart) / segment.speed, segment.timelineStart, segment.timelineStart + segment.duration),
        end: clamp(segment.timelineStart + (Math.min(word.end, sourceEnd) - segment.sourceStart) / segment.speed, segment.timelineStart, segment.timelineStart + segment.duration),
        segmentIndex: segment.index
      }))
      .filter((word) => word.end - word.start > 0.015);
  }).sort((a, b) => a.start - b.start);
}

function createCaptionPlan(plan, transcripts) {
  const words = mapWordsToTimeline(plan, transcripts);
  const captions = groupWords(words);
  const keywords = plan.flatMap((segment) => {
    const impact = segment.timelineStart + (segment.impactTime - segment.sourceStart) / segment.speed;
    const candidates = words
      .filter((word) => word.segmentIndex === segment.index && Math.abs(midpoint(word) - impact) <= 1.35)
      .filter((word) => keywordText(word.text).length >= 3 && !STOP_WORDS.has(keywordText(word.text).toLowerCase()))
      .sort((a, b) => keywordScore(b, impact) - keywordScore(a, impact));
    const word = candidates[0];
    if (!word) return [];
    return [{
      text: keywordText(word.text).toUpperCase(),
      start: clamp(impact - 0.08, segment.timelineStart, segment.timelineStart + segment.duration),
      end: clamp(impact + 0.62, segment.timelineStart, segment.timelineStart + segment.duration),
      segmentIndex: segment.index
    }];
  });
  return { words, captions, keywords };
}

function groupWords(words) {
  const groups = [];
  for (const word of words) {
    const current = groups.at(-1);
    const newGroup = !current || current.segmentIndex !== word.segmentIndex || word.start - current.end > 0.5 || current.words.length >= 5 || word.end - current.start > 2.2;
    if (newGroup) {
      groups.push({ start: word.start, end: word.end, segmentIndex: word.segmentIndex, words: [word] });
    } else {
      current.words.push(word);
      current.end = word.end;
    }
  }
  return groups.map((group) => ({
    ...group,
    start: Math.max(0, group.start - 0.06),
    end: Math.max(group.end + 0.18, group.start + 0.55),
    text: joinWords(group.words.map((word) => word.text))
  }));
}

function createAss({ captions, keywords }, { width, height }) {
  const baseSize = Math.max(18, Math.round(height * 0.052));
  const keywordSize = Math.max(32, Math.round(height * 0.115));
  const bottomMargin = Math.round(height * 0.075);
  const events = [
    ...captions.map((caption) => dialogue("Caption", caption.start, caption.end, escapeAss(caption.text))),
    ...keywords.map((keyword) => dialogue(
      "Keyword", keyword.start, keyword.end,
      `{\\an5\\pos(${Math.round(width / 2)},${Math.round(height * 0.46)})\\fscx65\\fscy65\\t(0,130,\\fscx118\\fscy118)\\t(130,260,\\fscx100\\fscy100)}${escapeAss(keyword.text)}`
    ))
  ].sort((a, b) => a.start - b.start).map((item) => item.line);
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
ScaledBorderAndShadow: yes
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,Arial,${baseSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&HCC000000,-1,0,0,0,100,100,0,0,3,5,0,2,28,28,${bottomMargin},1
Style: Keyword,Arial Black,${keywordSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,1.2,0,1,5,2,5,20,20,20,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events.join("\n")}
`;
}

function dialogue(style, start, end, text) {
  return { start, line: `Dialogue: ${style === "Keyword" ? 1 : 0},${assTime(start)},${assTime(Math.max(end, start + 0.08))},${style},,0,0,0,,${text}` };
}

function assTime(seconds) {
  const total = Math.max(0, seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = (total % 60).toFixed(2).padStart(5, "0");
  return `${hours}:${String(minutes).padStart(2, "0")}:${secs}`;
}

function escapeAss(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("{", "\\{").replaceAll("}", "\\}").replaceAll("\n", "\\N");
}

function joinWords(words) {
  return words.join(" ").replace(/\s+([,.!?;:])/g, "$1");
}

function keywordText(value) {
  return String(value).replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

function keywordScore(word, impact) {
  return (word.probability || 0) * 0.55 + Math.min(keywordText(word.text).length / 10, 1) * 0.2 + Math.max(0, 1 - Math.abs(midpoint(word) - impact) / 1.35) * 0.25;
}

function midpoint(word) {
  return (word.start + word.end) / 2;
}

function normalizePath(value) {
  return path.resolve(value).toLowerCase();
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

module.exports = { mapWordsToTimeline, createCaptionPlan, createAss, assTime, escapeAss };
