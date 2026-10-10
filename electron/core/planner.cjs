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

function createEventPlan({ duration, cuts, onsets, clips }) {
  if (!clips.length) return { duration, segments: [], cuts: [], detectedSceneCuts: cuts.length, detectedBeats: onsets.length };
  const boundaries = macroBoundaries(duration, cuts, clips.length);
  const segments = clips.map((clip, index) => {
    const timelineStart = boundaries[index];
    const segmentDuration = boundaries[index + 1] - timelineStart;
    const impact = detectImpact(clip.duration, clip.onsets || [], clip.candidates || []);
    const postRoll = Math.min(0.55, Math.max(0.25, segmentDuration * 0.1));
    const availableDuration = Math.min(clip.duration, segmentDuration);
    const speed = availableDuration / segmentDuration;
    const sourceStart = clamp(
      impact.time - availableDuration + postRoll,
      0,
      Math.max(0, clip.duration - availableDuration)
    );
    return {
      index,
      timelineStart,
      duration: segmentDuration,
      intensity: impact.score,
      effect: "clean",
      sourcePath: clip.path,
      sourceName: path.basename(clip.path),
      sourceStart,
      sourceDuration: availableDuration,
      speed,
      impactTime: impact.time,
      motionScore: impact.motionScore
    };
  });
  return {
    duration,
    segments,
    cuts: boundaries.slice(1, -1),
    detectedSceneCuts: cuts.length,
    detectedBeats: onsets.length
  };
}

function macroBoundaries(duration, cuts, clipCount) {
  if (clipCount <= 1) return [0, duration];
  const candidates = uniqueTimes(cuts.filter((time) => time > 0.4 && time < duration - 0.4), 0.16);
  const selected = [];
  for (let index = 1; index < clipCount; index += 1) {
    const target = (duration * index) / clipCount;
    const minimum = (selected.at(-1) || 0) + 1.25;
    const maximum = duration - (clipCount - index) * 1.25;
    const available = candidates.filter((time) => time >= minimum && time <= maximum && !selected.includes(time));
    const nearest = available.sort((a, b) => Math.abs(a - target) - Math.abs(b - target))[0];
    selected.push(nearest ?? clamp(target, minimum, maximum));
  }
  return [0, ...selected.sort((a, b) => a - b), duration];
}

function detectImpact(duration, onsets, motionCandidates) {
  const motionMaximum = Math.max(...motionCandidates.map((item) => item.score), 0.00001);
  const candidates = onsets
    .filter((item) => item.time >= duration * 0.18 && item.time <= duration - 0.12)
    .map((onset) => {
      const nearestMotion = motionCandidates.reduce((best, motion) => {
        const distance = Math.abs(motion.time - onset.time);
        return distance < best.distance ? { distance, score: motion.score } : best;
      }, { distance: Infinity, score: 0 });
      const motionScore = (nearestMotion.score / motionMaximum) * Math.max(0, 1 - nearestMotion.distance / 1.1);
      const lateBias = onset.time / duration;
      return {
        time: onset.time,
        score: onset.strength * 0.62 + motionScore * 0.28 + lateBias * 0.1,
        motionScore
      };
    });
  if (!candidates.length) {
    const fallback = motionCandidates.sort((a, b) => b.time - a.time)[0];
    return { time: fallback?.time || duration * 0.8, score: fallback?.score || 0, motionScore: fallback?.score || 0 };
  }
  return candidates.sort((a, b) => b.score - a.score)[0];
}

module.exports = {
  clamp, createBlueprint, assignClips, chooseEffect,
  createEventPlan, macroBoundaries, detectImpact
};
