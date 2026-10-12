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

function createEventPlan({ duration, cuts, onsets, clips, preferences = {} }) {
  if (!clips.length) return { duration, segments: [], cuts: [], detectedSceneCuts: cuts.length, detectedBeats: onsets.length };
  const macro = macroBoundaries(duration, cuts, clips.length);
  const segments = [];
  clips.forEach((clip, clipIndex) => {
    const macroStart = macro[clipIndex];
    const macroEnd = macro[clipIndex + 1];
    const macroDuration = macroEnd - macroStart;
    const overrideTime = Number(preferences.impactOverrides?.[clip.path]);
    const impact = Number.isFinite(overrideTime)
      ? { time: clamp(overrideTime, 0.05, Math.max(0.05, clip.duration - 0.05)), score: 1, motionScore: 1, type: "manual" }
      : detectImpact(clip.duration, clip.onsets || [], clip.candidates || [], preferences);
    const style = preferences.editingStyle || "balanced";
    const postRoll = preferences.impactPosition === "end"
      ? Math.min(0.1, macroDuration * 0.025)
      : style === "aggressive" ? Math.min(0.32, Math.max(0.16, macroDuration * 0.065))
        : style === "cinematic" ? Math.min(0.82, Math.max(0.42, macroDuration * 0.14))
          : Math.min(0.55, Math.max(0.25, macroDuration * 0.1));
    const speedFactor = style === "aggressive" ? 1.08 : style === "cinematic" ? 0.94 : 1;
    const availableDuration = Math.min(clip.duration, macroDuration * speedFactor);
    const speed = availableDuration / macroDuration;
    const idealHitTime = preferences.impactPosition === "center"
      ? macroStart + macroDuration * 0.5
      : macroEnd - postRoll;
    const hitTime = preferences.impactPosition === "end"
      ? idealHitTime
      : nearestRhythmHit(idealHitTime, macroStart, macroEnd, onsets, preferences.beatSync);
    const macroSourceStart = clamp(
      impact.time - (hitTime - macroStart) * speed,
      0,
      Math.max(0, clip.duration - availableDuration)
    );
    const mappedImpactTime = macroStart + (impact.time - macroSourceStart) / Math.max(speed, 0.00001);
    const internalCuts = cuts.filter((time) => time > macroStart + 0.28 && time < macroEnd - 0.28);
    const shotBoundaries = uniqueTimes([macroStart, ...internalCuts, macroEnd], 0.24);
    for (let shotIndex = 0; shotIndex < shotBoundaries.length - 1; shotIndex += 1) {
      const timelineStart = shotBoundaries[shotIndex];
      const segmentDuration = shotBoundaries[shotIndex + 1] - timelineStart;
      const sourceStart = macroSourceStart + (timelineStart - macroStart) * speed;
      const sourceDuration = segmentDuration * speed;
      const sourceEnd = sourceStart + sourceDuration;
      const containsImpact = impact.time >= sourceStart - 0.08 && impact.time <= sourceEnd + 0.08;
      const index = segments.length;
      const fillerEffects = style === "aggressive"
        ? ["push", "glitch", "shake"]
        : style === "cinematic" ? ["drift", "clean", "push"] : ["push", "drift", "glitch"];
      segments.push({
        index,
        clipIndex,
        timelineStart,
        duration: segmentDuration,
        intensity: containsImpact ? impact.score : Math.max(0.3, impact.score * 0.62),
        effect: containsImpact ? "impact" : fillerEffects[index % fillerEffects.length],
        editingStyle: style,
        sourcePath: clip.path,
        sourceName: path.basename(clip.path),
        fromMedal: Boolean(clip.fromMedal),
        hasAudio: clip.hasAudio !== false,
        sourceStart,
        sourceDuration,
        speed,
        impactTime: impact.time,
        hitTargetTime: hitTime,
        hitSyncError: Math.abs(mappedImpactTime - hitTime),
        keyMomentType: impact.type,
        motionScore: impact.motionScore
      });
    }
  });
  return {
    duration,
    segments,
    cuts: uniqueTimes(segments.slice(1).map((segment) => segment.timelineStart)),
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

function nearestRhythmHit(ideal, start, end, onsets, mode = "balanced") {
  const radius = mode === "strict" ? 1.2 : 0.55;
  const candidates = onsets
    .filter((beat) => beat.time >= start + 0.3 && beat.time <= end - 0.04)
    .filter((beat) => Math.abs(beat.time - ideal) <= radius)
    .map((beat) => ({
      ...beat,
      score: (beat.strength || 0) * (mode === "strict" ? 0.7 : 0.45)
        + Math.max(0, 1 - Math.abs(beat.time - ideal) / radius) * (mode === "strict" ? 0.3 : 0.55)
    }))
    .sort((a, b) => b.score - a.score);
  return candidates[0]?.time ?? ideal;
}

function detectImpact(duration, onsets, motionCandidates, preferences = {}) {
  const motionMaximum = Math.max(...motionCandidates.map((item) => item.score), 0.00001);
  const candidates = onsets
    // The final inventory/pickup sound is often the loudest event in a gaming
    // clip, but it happens after the elimination. Keep a short post-roll out of
    // the search so effects land on the fight instead of the loot collection.
    .filter((item) => item.time >= duration * 0.18 && item.time <= Math.min(duration - 0.12, duration * 0.92))
    .map((onset) => {
      const nearestMotion = motionCandidates.reduce((best, motion) => {
        const distance = Math.abs(motion.time - onset.time);
        return distance < best.distance ? { distance, score: motion.score } : best;
      }, { distance: Infinity, score: 0 });
      const motionScore = (nearestMotion.score / motionMaximum) * Math.max(0, 1 - nearestMotion.distance / 1.1);
      const lateBias = onset.time / duration;
      const pairedOnset = preferences.detectDoubleTaps === false ? null : onsets.find((other) => {
        const gap = Math.abs(other.time - onset.time);
        return other !== onset && gap >= 0.075 && gap <= 0.46 && other.strength >= 0.28;
      });
      const doubleTapScore = pairedOnset
        ? Math.min(onset.strength, pairedOnset.strength) * Math.max(0, 1 - Math.abs(Math.abs(pairedOnset.time - onset.time) - 0.22) / 0.3)
        : 0;
      return {
        time: onset.time,
        score: onset.strength * 0.52 + motionScore * 0.25 + lateBias * 0.08 + doubleTapScore * 0.15,
        motionScore,
        doubleTapScore,
        type: doubleTapScore >= 0.18 ? "double-tap" : "impact"
      };
    });
  if (!candidates.length) {
    const fallback = [...motionCandidates].sort((a, b) => b.score - a.score)[0];
    return { time: fallback?.time || duration * 0.8, score: fallback?.score || 0, motionScore: fallback?.score || 0, type: "motion" };
  }
  return candidates.sort((a, b) => b.score - a.score)[0];
}

module.exports = {
  clamp, createBlueprint, assignClips, chooseEffect,
  createEventPlan, macroBoundaries, detectImpact, nearestRhythmHit
};
