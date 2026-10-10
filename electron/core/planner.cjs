const path = require("node:path");

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function uniqueTimes(values, tolerance = 0.1) {
  return [...values]
    .sort((a, b) => a - b)
    .filter((value, index, all) => index === 0 || value - all[index - 1] >= tolerance);
}

function createBlueprint({ duration, cuts, onsets }) {
  const target = clamp(Number(duration) || 30, 15, 45);
  const strongBeats = onsets.filter((beat) => beat.strength >= 0.45).map((beat) => beat.time);
  let boundaries = uniqueTimes([0, ...cuts, target].filter((time) => time >= 0 && time <= target));

  const filled = [boundaries[0]];
  for (let index = 1; index < boundaries.length; index += 1) {
    const start = filled.at(-1);
    const end = boundaries[index];
    if (end - start > 2.4) {
      const beats = strongBeats.filter((time) => time > start + 0.4 && time < end - 0.35);
      const spacing = beats.length ? beats : regularPoints(start, end, 1.25);
      for (const time of spacing) {
        if (time - filled.at(-1) >= 0.32) filled.push(time);
      }
    }
    if (end - filled.at(-1) >= 0.24) filled.push(end);
  }
  boundaries = uniqueTimes(filled);
  if (boundaries.at(-1) !== target) boundaries.push(target);

  const segments = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const start = boundaries[index];
    const end = boundaries[index + 1];
    const segmentDuration = end - start;
    if (segmentDuration < 0.2) continue;
    const nearbyBeat = onsets.find((beat) => Math.abs(beat.time - end) < 0.12);
    const intensity = clamp((1.4 / Math.max(segmentDuration, 0.3)) * 0.55 + (nearbyBeat?.strength || 0) * 0.45, 0, 1);
    segments.push({
      index,
      timelineStart: start,
      duration: segmentDuration,
      intensity,
      effect: chooseEffect(index, intensity, Boolean(nearbyBeat))
    });
  }
  return { duration: target, segments, cuts: boundaries.slice(1, -1), detectedSceneCuts: cuts.length, detectedBeats: onsets.length };
}

function regularPoints(start, end, step) {
  const result = [];
  for (let time = start + step; time < end - 0.3; time += step) result.push(time);
  return result;
}

function chooseEffect(index, intensity, onBeat) {
  if (intensity > 0.82 && onBeat) return index % 2 ? "flash" : "punch";
  if (intensity > 0.62) return index % 3 === 0 ? "shake" : "push";
  if (intensity > 0.42) return "drift";
  return "clean";
}

function assignClips(blueprint, clips) {
  const pools = clips.map((clip) => ({
    ...clip,
    candidates: [...clip.candidates].sort((a, b) => b.score - a.score),
    used: []
  }));
  let previousPath = null;
  return blueprint.segments.map((segment, segmentIndex) => {
    const ranked = pools
      .flatMap((clip) => clip.candidates.map((candidate) => ({ clip, candidate })))
      .filter(({ clip, candidate }) => {
        const safeDuration = segment.duration * speedFor(segment.intensity);
        const start = clamp(candidate.time - safeDuration * 0.35, 0, Math.max(0, clip.duration - safeDuration));
        return clip.duration >= safeDuration && clip.used.every((used) => Math.abs(used - start) > 1.5);
      })
      .sort((a, b) => {
        const aPenalty = a.clip.path === previousPath ? 0.25 : 0;
        const bPenalty = b.clip.path === previousPath ? 0.25 : 0;
        return (b.candidate.score - bPenalty) - (a.candidate.score - aPenalty);
      });
    const pick = ranked[0] || fallbackPick(pools, segmentIndex);
    const speed = speedFor(segment.intensity);
    const sourceDuration = segment.duration * speed;
    const sourceStart = clamp(
      pick.candidate.time - sourceDuration * 0.35,
      0,
      Math.max(0, pick.clip.duration - sourceDuration)
    );
    pick.clip.used.push(sourceStart);
    previousPath = pick.clip.path;
    return {
      ...segment,
      sourcePath: pick.clip.path,
      sourceName: path.basename(pick.clip.path),
      sourceStart,
      sourceDuration,
      speed,
      motionScore: pick.candidate.score
    };
  });
}

function speedFor(intensity) {
  if (intensity > 0.82) return 1.22;
  if (intensity > 0.62) return 1.1;
  if (intensity < 0.28) return 0.9;
  return 1;
}

function fallbackPick(pools, index) {
  const clip = pools[index % pools.length];
  return { clip, candidate: clip.candidates[index % clip.candidates.length] || { time: 0, score: 0 } };
}

module.exports = { clamp, createBlueprint, assignClips, chooseEffect };
