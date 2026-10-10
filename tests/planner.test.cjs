const test = require("node:test");
const assert = require("node:assert/strict");
const { createBlueprint, assignClips, chooseEffect } = require("../electron/core/planner.cjs");
const { createFcpxml, escapeXml } = require("../electron/core/exporters.cjs");

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
