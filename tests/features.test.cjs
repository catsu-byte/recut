const test = require("node:test");
const assert = require("node:assert/strict");
const { createEventPlan } = require("../electron/core/planner.cjs");
const { detectKeyMoments } = require("../electron/core/keymoments.cjs");
const { effectFilters } = require("../electron/core/pipeline.cjs");
const { parseEditInstructions } = require("../electron/core/instructions.cjs");
const { alignPlainLyrics, looksTimed, timedLyricsFromText } = require("../electron/core/lyrics.cjs");
const { findStaticOverlay, clampBox } = require("../electron/core/watermark.cjs");
const { parseNameTable, textMaskFromGray, cropToContent, shapeSimilarity } = require("../electron/core/fonts.cjs");
const { validateMedalUrl, extractMedalMediaUrl, medalClipId } = require("../electron/core/medal.cjs");

function beatGrid(duration, step = 0.5) {
  const onsets = [];
  for (let time = step / 2; time < duration; time += step) {
    onsets.push({ time, strength: Math.round(time / step) % 4 === 0 ? 1 : 0.35 });
  }
  return onsets;
}

test("key moments find the last kill when the user says kills are at the clip end", () => {
  const clip = {
    duration: 10,
    onsets: [{ time: 3, strength: 1 }, { time: 9.7, strength: 0.9 }],
    candidates: [{ time: 3, score: 1 }, { time: 9.6, score: 0.8 }]
  };
  assert.equal(detectKeyMoments(clip).primary.time, 3);
  assert.equal(detectKeyMoments(clip, { impactPosition: "end" }).primary.time, 9.7);
});

test("multi-kills are grouped and the final kill becomes the primary hit", () => {
  const clip = {
    duration: 12,
    onsets: [{ time: 6, strength: 0.95 }, { time: 7.1, strength: 0.9 }, { time: 8.3, strength: 1 }],
    hfOnsets: [{ time: 6, strength: 1 }, { time: 7.1, strength: 1 }, { time: 8.3, strength: 1 }],
    candidates: [{ time: 6, score: 1 }, { time: 7.1, score: 1 }, { time: 8.3, score: 1 }]
  };
  const result = detectKeyMoments(clip);
  assert.equal(result.primary.type, "multi-kill");
  assert.equal(result.primary.time, 8.3);
  assert.equal(result.moments.length, 3);
});

test("global hit sync lands every visual hit on a strong beat", () => {
  const onsets = beatGrid(30);
  const clips = [12, 9, 20, 7].map((duration, index) => ({
    path: `clip-${index}.mp4`, duration,
    onsets: [{ time: duration - 1.5, strength: 1 }],
    candidates: [{ time: duration - 1.5, score: 1 }]
  }));
  const plan = createEventPlan({ duration: 30, cuts: [], onsets, clips, preferences: { beatSync: "strict" } });
  const strong = onsets.filter((beat) => beat.strength === 1).map((beat) => beat.time);
  for (const hit of plan.hits) assert.ok(strong.some((time) => Math.abs(time - hit) < 0.001), `hit ${hit} is not a strong beat`);
  for (const segment of plan.segments) assert.ok(segment.hitSyncError < 0.01);
  const total = plan.segments.reduce((sum, segment) => sum + segment.duration, 0);
  assert.ok(Math.abs(total - 30) < 0.001);
  assert.deepEqual([...new Set(plan.segments.map((segment) => segment.clipIndex))], [0, 1, 2, 3]);
});

test("speed ramps slow down the kill and a short clip end is held with a freeze frame", () => {
  const clips = [{
    path: "short-tail.mp4", duration: 6,
    onsets: [{ time: 5.9, strength: 1 }], candidates: [{ time: 5.8, score: 1 }]
  }];
  const plan = createEventPlan({
    duration: 7, cuts: [], onsets: [{ time: 5.5, strength: 1 }], clips,
    preferences: { impactPosition: "end", editingStyle: "aggressive" }
  });
  assert.ok(plan.segments.some((segment) => segment.speed <= 0.55), "expected a slow-motion segment");
  assert.ok(plan.segments.some((segment) => segment.speed >= 1.2), "expected a speed-up into the kill");
  assert.ok(plan.segments.at(-1).freeze > 0, "expected a freeze frame at the end");
  for (const segment of plan.segments) assert.ok(segment.sourceStart + segment.sourceDuration <= 6 + 1e-6);
});

test("speed ramps can be disabled from the instruction text", () => {
  const clips = [{ path: "a.mp4", duration: 12, onsets: [{ time: 8, strength: 1 }], candidates: [{ time: 8, score: 1 }] }];
  const { preferences } = parseEditInstructions("keine Slowmo bitte");
  const plan = createEventPlan({ duration: 10, cuts: [], onsets: [], clips, preferences });
  assert.ok(plan.segments.every((segment) => Math.abs(segment.speed - 1) < 0.15));
});

test("effect filters describe impact, accents, pulses, whip-in and freeze without invalid numbers", () => {
  const filters = effectFilters({
    effect: "impact", flashAt: 0.5, accents: [0.2], pulses: [0.8], pulseAmount: 0.05,
    whipIn: true, freeze: 0.3, speed: 0.5, editingStyle: "aggressive"
  }, "scale=1280:720", 1280, 720, 1.2);
  assert.doesNotMatch(filters, /NaN|undefined|Infinity/);
  assert.match(filters, /tpad=stop_mode=clone/);
  assert.match(filters, /rgbashift/);
  assert.match(filters, /scale=w='trunc/);
});

test("instruction parser understands the user's own phrasing", () => {
  const parsed = parseEditInstructions("die kills sind immer am ende der einzelnen angelegten clips");
  assert.equal(parsed.preferences.impactPosition, "end");
  const window = parseEditInstructions("Kill ist in den letzten 2,5 Sekunden. Wasserzeichen bei allen Clips weg");
  assert.equal(window.preferences.impactSearchSeconds, 2.5);
  assert.equal(window.preferences.watermarkScope, "all");
  const style = parseEditInstructions("nicht aggressiv, eher smooth, keine lyrics");
  assert.equal(style.preferences.editingStyle, "cinematic");
  assert.equal(style.preferences.lyrics, false);
  assert.ok(style.labels.length >= 2);
});

test("pasted lyrics replace misheard words and keep Whisper timing", () => {
  const heard = { segments: [{ words: [["ai", 1], ["feel", 1.3], ["so", 1.6], ["alife", 1.8], ["tonite", 2.4]]
    .map(([text, start]) => ({ text, start, end: start + 0.25, probability: 0.6 })) }] };
  const result = alignPlainLyrics(heard, "[Verse]\nWe walk in the dark\nI feel so alive tonight\nNothing can stop us");
  const words = result.segments.flatMap((segment) => segment.words);
  assert.deepEqual(words.map((word) => word.text), ["I", "feel", "so", "alive", "tonight"]);
  assert.equal(words[3].start, 1.8);
});

test("unrelated pasted lyrics leave the transcript untouched", () => {
  const heard = { segments: [{ words: [{ text: "hello", start: 0, end: 0.3 }, { text: "world", start: 0.4, end: 0.7 }] }] };
  assert.equal(alignPlainLyrics(heard, "completely different words here"), heard);
});

test("pasted LRC text is recognised as timed lyrics", () => {
  assert.ok(looksTimed("[00:12.30] line"));
  assert.ok(!looksTimed("just words"));
  const transcript = timedLyricsFromText("[00:01.00]first line\n[00:03.00]second line", 6);
  assert.equal(transcript.segments.length, 2);
});

test("watermark finder locates a static overlay in a corner of moving footage", () => {
  const width = 160;
  const height = 90;
  const frames = Buffer.alloc(width * height * 12);
  for (let frame = 0; frame < 12; frame += 1) {
    // Moving stripes stand in for gameplay: sharp edges that never stay put.
    for (let index = 0; index < width * height; index += 1) {
      const x = index % width;
      const y = Math.floor(index / width);
      frames[frame * width * height + index] = (x + y + frame * 7) % 16 < 8 ? 60 : 110;
    }
    // A static logo with sharp edges in the bottom-right corner.
    for (let y = 70; y < 82; y += 1) {
      for (let x = 120; x < 150; x += 1) frames[frame * width * height + y * width + x] = (x + y) % 4 < 2 ? 250 : 10;
    }
  }
  const box = findStaticOverlay(frames, width, height);
  assert.equal(box.corner, "bottom-right");
  assert.ok(box.x <= 120 && box.x + box.w >= 150 && box.y <= 70 && box.y + box.h >= 82);
  assert.deepEqual(clampBox({ x: 0, y: 0, w: 500, h: 10 }, 320, 180), { x: 1, y: 1, w: 318, h: 10 });
});

test("font name table parsing reads the family name", () => {
  const name = Buffer.from("Anton", "utf16le").swap16();
  const table = Buffer.alloc(6 + 12 + name.length);
  table.writeUInt16BE(0, 0);
  table.writeUInt16BE(1, 2);
  table.writeUInt16BE(18, 4);
  table.writeUInt16BE(3, 6); table.writeUInt16BE(1, 8); table.writeUInt16BE(0x409, 10);
  table.writeUInt16BE(1, 12); table.writeUInt16BE(name.length, 14); table.writeUInt16BE(0, 16);
  name.copy(table, 18);
  assert.equal(parseNameTable(table).family, "Anton");
});

test("font matching compares text shapes independent of colour and position", () => {
  const draw = (width, height, bright, rects) => {
    const gray = Buffer.alloc(width * height, bright ? 20 : 230);
    for (const [x0, y0, x1, y1] of rects) {
      for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) gray[y * width + x] = bright ? 240 : 15;
    }
    return cropToContent(textMaskFromGray(gray, width, height));
  };
  const target = draw(120, 60, true, [[10, 10, 20, 50], [30, 10, 60, 20], [70, 10, 80, 50]]);
  const same = draw(200, 100, false, [[40, 20, 60, 100], [80, 20, 140, 40], [160, 20, 180, 100]]);
  const different = draw(120, 60, true, [[10, 30, 110, 40]]);
  assert.ok(shapeSimilarity(target, same) > shapeSimilarity(target, different));
});

test("Medal links accept common share formats", () => {
  assert.equal(medalClipId(validateMedalUrl("medal.tv/games/valorant/clips/abc123/some-title?invite=x")), "abc123");
  assert.equal(medalClipId(validateMedalUrl("https://medal.tv/?contentId=xyz789")), "xyz789");
  assert.equal(medalClipId(validateMedalUrl("http://www.medal.tv/clip/q1w2e3")), "q1w2e3");
  const url = extractMedalMediaUrl('{"contentUrl480p":"https:\\/\\/cdn.medal.tv\\/a\\/480p.mp4","contentUrl1080p":"https:\\/\\/cdn.medal.tv\\/a\\/1080p.mp4"}');
  assert.match(url.href, /1080p/);
});
