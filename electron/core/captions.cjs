const path = require("node:path");

const STOP_WORDS = new Set([
  "aber", "also", "and", "auch", "auf", "das", "der", "die", "ein", "eine", "for", "für",
  "hier", "ich", "ist", "mit", "nicht", "oder", "the", "und", "von", "was", "wir", "you"
]);
const IMPACT_LEAD_SECONDS = 0.42;

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
  const duration = Math.max(...plan.map((segment) => segment.timelineStart + segment.duration), 0);
  const captions = fillCaptionGaps(
    groupWords(words).filter((caption) => caption.words.length > 1 || keywordText(caption.text).length >= 4),
    duration
  );
  const keywords = plan.flatMap((segment) => {
    const impact = displayImpactTime(segment);
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

function createLyricCaptionPlan(plan, transcript) {
  const words = (transcript?.segments || []).flatMap((segment) => segment.words || [])
    .map((word) => ({
      text: word.text,
      probability: word.probability,
      start: Math.max(0, word.start),
      end: Math.max(word.start + 0.03, word.end)
    }))
    .sort((a, b) => a.start - b.start);
  const duration = Math.max(...plan.map((segment) => segment.timelineStart + segment.duration), 0);
  const captions = fillCaptionGaps(
    groupWords(words).filter((caption) => caption.words.length > 1 || keywordText(caption.text).length >= 4),
    duration
  );
  const keywords = plan.flatMap((segment) => {
    const impact = clamp(
      displayImpactTime(segment),
      segment.timelineStart,
      segment.timelineStart + segment.duration
    );
    const candidates = words
      .filter((word) => Math.abs(midpoint(word) - impact) <= 1.1)
      .filter((word) => keywordText(word.text).length >= 3 && !STOP_WORDS.has(keywordText(word.text).toLowerCase()))
      .sort((a, b) => keywordScore(b, impact) - keywordScore(a, impact));
    const word = candidates[0];
    if (!word) return [];
    return [{
      text: keywordText(word.text).toUpperCase(),
      start: Math.max(segment.timelineStart, impact - 0.06),
      end: impact + 0.68,
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
  const keywordSize = Math.max(46, Math.round(height * 0.17));
  const bottomMargin = Math.round(height * 0.075);
  const events = [
    ...captions.flatMap(captionEvents),
    ...keywords.flatMap((keyword, index) => keywordEvents(keyword, index, width, height))
  ].sort((a, b) => a.start - b.start).map((item) => item.line);
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
ScaledBorderAndShadow: yes
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,Arial,${baseSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&HD0000000,-1,0,0,0,100,100,0,0,3,4,0,2,28,28,${bottomMargin},1
Style: KeywordGlowWide,Arial Black,${keywordSize},&H40705BFF,&H40705BFF,&H40705BFF,&H00000000,-1,0,0,0,100,100,1.2,0,1,14,0,5,20,20,20,1
Style: KeywordGlow,Arial Black,${keywordSize},&H18705BFF,&H18705BFF,&H18705BFF,&H00000000,-1,0,0,0,100,100,1.2,0,1,7,0,5,20,20,20,1
Style: KeywordDepth,Arial Black,${keywordSize},&H00322472,&H00322472,&H00140B35,&H00000000,-1,0,0,0,100,100,1.2,0,1,3,0,5,20,20,20,1
Style: Keyword,Arial Black,${keywordSize},&H006F78FF,&H006F78FF,&H00201548,&H00000000,-1,0,0,0,100,100,1.2,0,1,2,1,5,20,20,20,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events.join("\n")}
`;
}

function keywordEvents(keyword, index, width, height) {
  const palette = [
    { front: "&H006F78FF&", accent: "&H005247FF&", depth: "&H00221769&", rotation: -3, x: 0.50, y: 0.63 },
    { front: "&H005B83FF&", accent: "&H00405FFF&", depth: "&H00172869&", rotation: 3, x: 0.69, y: 0.43 },
    { front: "&H007D8FFF&", accent: "&H00545FFF&", depth: "&H00221D72&", rotation: -2, x: 0.34, y: 0.55 },
    { front: "&H006D70FF&", accent: "&H00464BFF&", depth: "&H00201868&", rotation: 2, x: 0.56, y: 0.35 }
  ][index % 4];
  const x = Math.round(width * palette.x);
  const y = Math.round(height * palette.y);
  const startX = x + (index % 2 ? 52 : -52);
  const transform = `\\an5\\fnArial Black\\frz${palette.rotation}\\fscx58\\fscy58\\t(0,120,\\fscx116\\fscy116\\frz0)\\t(120,260,\\fscx100\\fscy100)\\fad(25,170)`;
  const movement = (offsetX = 0, offsetY = 0) => `\\move(${startX + offsetX},${y + 18 + offsetY},${x + offsetX},${y + offsetY},0,150)`;
  const text = escapeAss(keyword.text);
  return [
    dialogue("KeywordGlowWide", keyword.start, keyword.end, `{${transform}${movement()}\\c${palette.accent}\\3c${palette.accent}\\blur18}${text}`, 1),
    dialogue("KeywordGlow", keyword.start, keyword.end, `{${transform}${movement()}\\c${palette.accent}\\3c${palette.accent}\\blur8}${text}`, 2),
    dialogue("KeywordDepth", keyword.start, keyword.end, `{${transform}${movement(15, 16)}\\c${palette.depth}\\3c${palette.depth}}${text}`, 3),
    dialogue("KeywordDepth", keyword.start, keyword.end, `{${transform}${movement(9, 10)}\\c${palette.depth}\\3c${palette.depth}}${text}`, 4),
    dialogue("Keyword", keyword.start, keyword.end, `{${transform}${movement()}\\c${palette.front}\\3c&H00201548&}${text}`, 5)
  ];
}

function captionEvents(caption) {
  if (!caption.words?.length) return [dialogue("Caption", caption.start, caption.end, escapeAss(caption.text))];
  return caption.words.map((word, index) => {
    const start = index === 0 ? caption.start : Math.max(caption.start, word.start);
    const next = caption.words[index + 1];
    const end = next ? Math.max(start + 0.06, next.start) : caption.end;
    const text = joinWords(caption.words.slice(0, index + 1).map((item) => item.text));
    return dialogue("Caption", start, end, escapeAss(text));
  });
}

function displayImpactTime(segment) {
  return segment.timelineStart + (segment.impactTime - segment.sourceStart) / segment.speed - IMPACT_LEAD_SECONDS;
}

function fillCaptionGaps(captions, duration) {
  if (!captions.length) return captions;
  return captions.map((caption, index) => ({
    ...caption,
    start: index === 0 ? 0 : caption.start,
    end: index < captions.length - 1
      ? Math.max(caption.start + 0.08, captions[index + 1].start)
      : Math.max(caption.end, duration)
  }));
}

function dialogue(style, start, end, text, layer = 0) {
  return { start, line: `Dialogue: ${layer},${assTime(start)},${assTime(Math.max(end, start + 0.08))},${style},,0,0,0,,${text}` };
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
  return (word.probability || 0) * 0.35 + Math.min(keywordText(word.text).length / 10, 1) * 0.15 + Math.max(0, 1 - Math.abs(midpoint(word) - impact) / 1.35) * 0.5;
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

module.exports = { mapWordsToTimeline, createCaptionPlan, createLyricCaptionPlan, createAss, assTime, escapeAss };
