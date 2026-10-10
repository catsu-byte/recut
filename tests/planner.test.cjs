const test = require("node:test");
const assert = require("node:assert/strict");
const { createBlueprint, assignClips, chooseEffect, createEventPlan, macroBoundaries, detectImpact } = require("../electron/core/planner.cjs");
const { createFcpxml, escapeXml } = require("../electron/core/exporters.cjs");
const { selectDuration, parsePacketDuration, correlateEnvelopes } = require("../electron/core/media.cjs");
const { montageDuration, outputProfile } = require("../electron/core/pipeline.cjs");
const { createCaptionPlan, createLyricCaptionPlan, createAss } = require("../electron/core/captions.cjs");

test("blueprint keeps the requested montage duration", () => {
  const blueprint = createBlueprint({
    duration: 30,
    cuts: [0.8, 1.5, 3.1, 8, 14.5, 22],
    onsets: Array.from({ length: 50 }, (_, index) => ({ time: index * 0.6, strength: index % 3 ? 0.3 : 0.9 }))
  });
  const total = blueprint.segments.reduce((sum, segment) => sum + segment.duration, 0);
  assert.ok(Math.abs(total - 30) < 0.001);
  assert.ok(blueprint.segments.every((segment) => segment.duration >= 0.2));
});

test("duration is constrained to short-form limits", () => {
  assert.equal(createBlueprint({ duration: 5, cuts: [], onsets: [] }).duration, 15);
  assert.equal(createBlueprint({ duration: 90, cuts: [], onsets: [] }).duration, 45);
});

test("clip assignment stays inside source bounds", () => {
  const blueprint = createBlueprint({ duration: 15, cuts: [3, 6, 9, 12], onsets: [] });
  const clips = [
    { path: "a.mp4", duration: 20, candidates: [{ time: 4, score: 0.9 }, { time: 12, score: 0.7 }] },
    { path: "b.mp4", duration: 18, candidates: [{ time: 7, score: 0.8 }, { time: 14, score: 0.6 }] }
  ];
  const plan = assignClips(blueprint, clips);
  assert.equal(plan.length, blueprint.segments.length);
  for (const segment of plan) {
    const clip = clips.find((item) => item.path === segment.sourcePath);
    assert.ok(segment.sourceStart >= 0);
    assert.ok(segment.sourceStart + segment.sourceDuration <= clip.duration + 0.001);
  }
});

test("one source clip can fill a complete montage", () => {
  const blueprint = createBlueprint({ duration: 15, cuts: [2, 4, 7, 10, 12], onsets: [] });
  const clips = [
    { path: "single.mp4", duration: 45, candidates: [
      { time: 4, score: 0.9 }, { time: 10, score: 0.8 }, { time: 18, score: 0.7 },
      { time: 26, score: 0.6 }, { time: 35, score: 0.5 }
    ] }
  ];
  const plan = assignClips(blueprint, clips);
  assert.equal(plan.length, blueprint.segments.length);
  assert.ok(plan.every((segment) => segment.sourcePath === "single.mp4"));
});

test("effect selection is deterministic", () => {
  assert.equal(chooseEffect(1, 0.9, true), "flash");
  assert.equal(chooseEffect(2, 0.9, true), "punch");
  assert.equal(chooseEffect(2, 0.1, false), "clean");
});

test("FCPXML escapes paths and describes every segment", () => {
  const xml = createFcpxml({
    segments: [
      { duration: 1, renderedPath: "C:\\clips\\one & two.mp4", sourceName: "one", effect: "clean" },
      { duration: 2, renderedPath: "C:\\clips\\three.mp4", sourceName: "three", effect: "push" }
    ],
    musicPath: "C:\\music\\track.mp3",
    width: 1920,
    height: 1080,
    fps: 30
  });
  assert.match(xml, /one%20&amp;%20two\.mp4/);
  assert.equal((xml.match(/hasVideo="1"/g) || []).length, 2);
  assert.match(xml, /duration="90\/30s"/);
});

test("XML escaping handles unsafe characters", () => {
  assert.equal(escapeXml(`a&<>'"`), "a&amp;&lt;&gt;&apos;&quot;");
});

test("media duration ignores invalid negative container metadata", () => {
  const duration = selectDuration({
    format: { duration: "-1.000000" },
    streams: [{ codec_type: "video", duration: "28.417" }, { codec_type: "audio", duration: "28.4" }]
  });
  assert.equal(duration, 28.417);
});

test("media duration fails clearly when every duration is invalid", () => {
  assert.throws(
    () => selectDuration({ format: { duration: "-1" }, streams: [{ duration: "N/A" }] }, "broken.mp4"),
    /Could not read a valid duration/
  );
});

test("montage duration supports references shorter than fifteen seconds", () => {
  assert.equal(montageDuration(30, 9.5), 9.5);
  assert.equal(montageDuration(20, 32), 20);
});

test("packet timestamps provide a fallback duration", () => {
  assert.ok(Math.abs(parsePacketDuration("0.000000,0.033333\n12.500000,0.033333\n28.383000,0.034000\n") - 28.417) < 0.000001);
});

test("audio correlation finds the matching music section", () => {
  const reference = [0, 1, 0.5, -0.5, -1, 0.25];
  const music = [8, 8, 8, 0, 2, 1, -1, -2, 0.5, 8, 8];
  assert.equal(correlateEnvelopes(reference, music).index, 3);
});

test("macro cuts follow nearby reference transitions", () => {
  assert.deepEqual(macroBoundaries(25, [3.1, 7.2, 9.5, 14.4, 19.8], 5), [0, 3.1, 9.5, 14.4, 19.8, 25]);
});

test("event planner preserves source order and ends each macro shot after impact", () => {
  const clips = ["a", "b", "c"].map((name, index) => ({
    path: `${name}.mp4`, duration: 8,
    onsets: [{ time: 5 + index * 0.2, strength: 1 }],
    candidates: [{ time: 5 + index * 0.2, score: 0.8 }]
  }));
  const plan = createEventPlan({ duration: 18, cuts: [5.8, 12.2], onsets: [], clips });
  assert.deepEqual([...new Set(plan.segments.map((segment) => segment.sourcePath))], ["a.mp4", "b.mp4", "c.mp4"]);
  for (const sourcePath of ["a.mp4", "b.mp4", "c.mp4"]) {
    const finalShot = plan.segments.filter((segment) => segment.sourcePath === sourcePath).at(-1);
    assert.ok(finalShot.sourceStart + finalShot.sourceDuration > finalShot.impactTime);
  }
  assert.ok(plan.segments.some((segment) => segment.effect === "impact"));
});

test("impact detection combines sound and visual change", () => {
  const impact = detectImpact(8, [{ time: 2, strength: 0.4 }, { time: 6, strength: 1 }], [{ time: 6.1, score: 0.8 }]);
  assert.equal(impact.time, 6);
});

test("output profile creates a sharpened HD delivery canvas", () => {
  assert.deepEqual(outputProfile([{ width: 640, height: 360, fps: 29 }, { width: 640, height: 360, fps: 29 }], "16:9"), {
    width: 1280, height: 720, fps: 29
  });
});

test("captions map source words into the edited timeline", () => {
  const plan = [{
    index: 0, timelineStart: 4, duration: 4, sourcePath: "clip.mp4",
    sourceStart: 2, sourceDuration: 4, speed: 1, impactTime: 5
  }];
  const transcripts = [{
    path: "clip.mp4",
    segments: [{ words: [
      { text: "Oh", start: 4.6, end: 4.8, probability: 0.9 },
      { text: "Crystal!", start: 4.8, end: 5.1, probability: 0.95 }
    ] }]
  }];
  const result = createCaptionPlan(plan, transcripts);
  assert.equal(result.captions[0].text, "Oh Crystal!");
  assert.equal(result.keywords[0].text, "CRYSTAL");
  assert.ok(Math.abs(result.keywords[0].start - 6.92) < 0.001);
});

test("ASS output uses a boxed bottom caption and animated keyword style", () => {
  const ass = createAss({
    captions: [{ text: "mein Gott", start: 1, end: 2 }],
    keywords: [{ text: "GOTT", start: 1.4, end: 2 }]
  }, { width: 640, height: 360 });
  assert.match(ass, /Style: Caption,Arial,19,[^\n]+,3,4,0,2/);
  assert.match(ass, /Style: KeywordGlow,Impact/);
  assert.match(ass, /\\fscx35.*\\t\(0,105,\\fscx128/);
  assert.match(ass, /Dialogue: 2,0:00:01\.40,0:00:02\.00,Keyword/);
});

test("lyric captions use song timestamps and promote words near impacts", () => {
  const plan = [{
    index: 0, timelineStart: 0, duration: 4, sourcePath: "clip.mp4",
    sourceStart: 1, sourceDuration: 4, speed: 1, impactTime: 3.5
  }];
  const transcript = { segments: [{ words: [
    { text: "Everything", start: 1.9, end: 2.2, probability: 0.9 },
    { text: "fine", start: 2.4, end: 2.8, probability: 0.95 }
  ] }] };
  const result = createLyricCaptionPlan(plan, transcript);
  assert.equal(result.captions[0].text, "Everything fine");
  assert.equal(result.keywords[0].text, "FINE");
});
