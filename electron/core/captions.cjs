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

function createAss({ captions, keywords }, { width, height, fontName = "Arial", keywordFontName = "Bebas Neue" }) {
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
Style: Caption,${sanitizeAssFont(fontName)},${baseSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&HD0000000,-1,0,0,0,100,100,0,0,3,4,0,2,28,28,${bottomMargin},1
Style: KeywordAura,${sanitizeAssFont(keywordFontName)},${keywordSize},&H58705BFF,&H58705BFF,&H58705BFF,&H00000000,-1,0,0,0,100,100,1.8,0,1,8,0,5,20,20,20,1
Style: KeywordTrail,${sanitizeAssFont(keywordFontName)},${keywordSize},&H58624FFF,&H58624FFF,&H58624FFF,&H00000000,-1,0,0,0,100,100,1.8,0,1,0,0,5,20,20,20,1
Style: KeywordDepth,${sanitizeAssFont(keywordFontName)},${keywordSize},&H2446258A,&H2446258A,&H2446258A,&H00000000,-1,0,0,0,100,100,1.8,0,1,0,0,5,20,20,20,1
Style: Keyword,${sanitizeAssFont(keywordFontName)},${keywordSize},&H126876FF,&H126876FF,&H126876FF,&H00000000,-1,0,0,0,100,100,1.8,0,1,0,0,5,20,20,20,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events.join("\n")}
`;
}

function sanitizeAssFont(value) {
  return String(value || "Arial").replace(/[\r\n,]/g, " ").trim() || "Arial";
}

function keywordEvents(keyword, index, width, height) {
  const palette = [
    { front: "&H126876FF&", glow: "&H385849FF&", depth: "&H2446258A&", rotation: -2, x: 0.50, y: 0.62 },
    { front: "&H12617FFF&", glow: "&H38505FFF&", depth: "&H2432218C&", rotation: 2, x: 0.68, y: 0.43 },
    { front: "&H127084FF&", glow: "&H385B65FF&", depth: "&H243D278C&", rotation: -1, x: 0.34, y: 0.55 },
    { front: "&H126978FF&", glow: "&H38544DFF&", depth: "&H243A2588&", rotation: 1, x: 0.56, y: 0.36 }
  ][index % 4];
  const x = Math.round(width * palette.x);
  const y = Math.round(height * palette.y);
  const direction = index % 2 ? 1 : -1;
  const startX = x + direction * 82;
  const transform = `\\an5\\frz${palette.rotation}\\fscx82\\fscy82\\blur2.4\\t(0,165,\\fscx106\\fscy106\\blur0.25\\frz0)\\t(165,310,\\fscx100\\fscy100)\\fad(55,230)`;
  const movement = (offsetX = 0, offsetY = 0) => `\\move(${startX + offsetX},${y + 10 + offsetY},${x + offsetX},${y + offsetY},0,175)`;
  const text = escapeAss(keyword.text);
  return [
    dialogue("KeywordAura", keyword.start, keyword.end, `{${transform}${movement()}\\c${palette.glow}\\3c${palette.glow}\\blur14}${text}`, 1),
    dialogue("KeywordTrail", keyword.start, keyword.end, `{${transform}${movement(direction * 38, 4)}\\c&H70624FFF&\\blur5}${text}`, 2),
    dialogue("KeywordTrail", keyword.start, keyword.end, `{${transform}${movement(direction * 25, 3)}\\c&H58624FFF&\\blur3.5}${text}`, 3),
    dialogue("KeywordTrail", keyword.start, keyword.end, `{${transform}${movement(direction * 13, 2)}\\c&H40624FFF&\\blur2}${text}`, 4),
    dialogue("KeywordDepth", keyword.start, keyword.end, `{${transform}${movement(8, 9)}\\c${palette.depth}\\blur0.5}${text}`, 5),
    dialogue("Keyword", keyword.start, keyword.end, `{${transform}${movement()}\\c${palette.front}\\bord0\\shad0}${text}`, 6)
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
