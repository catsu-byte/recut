const path = require("node:path");
const { detectKeyMoments, detectImpact } = require("./keymoments.cjs");

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

// Seconds between the visual hit and the detected kill sound in the source
// clip: the audible confirmation (death sound, totem pop) trails the hit that
// caused it. The visual hit is what lands on the beat and gets the flash.
const IMPACT_LEAD_SECONDS = 0.42;

const STYLES = Object.freeze({
  aggressive: {
    base: 1.08, fastIn: { length: 0.4, speed: 1.4 }, slow: { length: 0.32, speed: 0.5 },
    idealPost: 0.3, minPre: 0.5, maxFreeze: 0.45, pulse: 0.05,
    fillers: ["push", "glitch", "shake"]
  },
  balanced: {
    base: 1, fastIn: { length: 0.35, speed: 1.25 }, slow: { length: 0.36, speed: 0.6 },
    idealPost: 0.42, minPre: 0.7, maxFreeze: 0.6, pulse: 0.035,
    fillers: ["push", "drift", "glitch"]
  },
  cinematic: {
    base: 0.94, fastIn: null, slow: { length: 0.62, speed: 0.55 },
    idealPost: 0.75, minPre: 0.9, maxFreeze: 0.8, pulse: 0,
    fillers: ["drift", "clean", "push"]
  }
});

function styleProfile(preferences = {}) {
  const style = STYLES[preferences.editingStyle] ? preferences.editingStyle : "balanced";
  const profile = { ...STYLES[style], name: style };
  if (preferences.speedRamps === false) { profile.fastIn = null; profile.slow = null; }
  if (preferences.freezeFrames === false) profile.maxFreeze = 0;
  if (preferences.effectIntensity === "low") profile.pulse = 0;
  if (preferences.effectIntensity === "high") profile.pulse = Math.max(profile.pulse, 0.05) * 1.3;
  if (preferences.impactPosition === "center") profile.idealPost = null;
  return profile;
}

function createEventPlan({ duration, cuts, onsets, clips, preferences = {} }) {
  if (!clips.length) return { duration, segments: [], cuts: [], detectedSceneCuts: cuts.length, detectedBeats: onsets.length };
  const profile = styleProfile(preferences);
  const prepared = clips.map((clip) => prepareClip(clip, preferences, profile));
  const hits = assignHits(duration, cuts, onsets, prepared, profile, preferences);
  const boundaries = chooseBoundaries(duration, hits, prepared, cuts, onsets, profile);
  const strongBeats = onsets.filter((beat) => beat.strength >= 0.55).map((beat) => beat.time);
  const segments = [];
  prepared.forEach((clip, clipIndex) => {
    const macroStart = boundaries[clipIndex];
    const macroEnd = boundaries[clipIndex + 1];
    const mapping = mapMacro(clip, macroStart, hits[clipIndex], macroEnd, profile);
    const flashTime = mapping.anchorTimeline;
    const accentTimes = clip.moments
      .filter((moment) => Math.abs(moment.time - clip.impact.time) >= 0.25)
      .map((moment) => mapping.toTimeline(Math.max(0, moment.time - clip.lead)))
      .filter((time) => Number.isFinite(time) && time > macroStart + 0.05 && time < macroEnd - 0.05);
    const internalCuts = cuts.filter((time) => time > macroStart + 0.28 && time < macroEnd - 0.28);
    const shotBoundaries = uniqueTimes([macroStart, ...internalCuts, ...mapping.rampPoints, macroEnd], 0.14)
      .filter((time) => time >= macroStart && time <= macroEnd);
    if (shotBoundaries.at(-1) < macroEnd - 0.001) shotBoundaries.push(macroEnd);
    if (shotBoundaries.length > 2 && macroEnd - shotBoundaries.at(-2) < 0.14) shotBoundaries.splice(-2, 1);
    for (let shotIndex = 0; shotIndex < shotBoundaries.length - 1; shotIndex += 1) {
      const timelineStart = shotBoundaries[shotIndex];
      const timelineEnd = shotBoundaries[shotIndex + 1];
      const segmentDuration = timelineEnd - timelineStart;
      const source = mapping.sourceRange(timelineStart, timelineEnd);
      const index = segments.length;
      const flashAt = flashTime - timelineStart;
      const touchesImpact = flashAt > -0.2 && flashAt < segmentDuration + 0.64;
      const accents = accentTimes.map((time) => time - timelineStart).filter((time) => time >= 0 && time < segmentDuration);
      const pulses = profile.pulse && !touchesImpact
        ? strongBeats.map((time) => time - timelineStart).filter((time) => time > 0.04 && time < segmentDuration - 0.04)
        : [];
      const impactScore = clip.impact.score || 0;
      segments.push({
        index,
        clipIndex,
        timelineStart,
        duration: segmentDuration,
        intensity: touchesImpact ? impactScore : Math.max(0.3, impactScore * 0.62),
        effect: touchesImpact ? "impact" : profile.fillers[index % profile.fillers.length],
        editingStyle: profile.name,
        sourcePath: clip.path,
        sourceName: path.basename(clip.path),
        fromMedal: Boolean(clip.fromMedal),
        hasAudio: clip.hasAudio !== false,
        sourceStart: source.start,
        sourceDuration: source.duration,
        speed: source.speed,
        freeze: source.freeze,
        flashAt: touchesImpact ? flashAt : null,
        flashTime,
        accents,
        pulses,
        pulseAmount: profile.pulse,
        whipIn: shotIndex === 0 && clipIndex > 0 && preferences.transitions !== false,
        impactTime: clip.impact.time,
        anchorTime: clip.anchor,
        hitTargetTime: hits[clipIndex],
        hitSyncError: Math.abs(mapping.anchorTimeline - hits[clipIndex]),
        keyMomentType: clip.impact.type,
        keyMoments: clip.moments.map((moment) => ({ time: moment.time, type: moment.type, score: moment.score })),
        motionScore: clip.impact.motionScore
      });
    }
  });
  return {
    duration,
    segments,
    hits,
    boundaries,
    cuts: uniqueTimes(segments.slice(1).map((segment) => segment.timelineStart)),
    detectedSceneCuts: cuts.length,
    detectedBeats: onsets.length
  };
}

function prepareClip(clip, preferences, profile) {
  const overrideTime = Number(preferences.impactOverrides?.[clip.path]);
  let impact;
  let moments;
  if (Number.isFinite(overrideTime)) {
    impact = { time: clamp(overrideTime, 0.05, Math.max(0.05, clip.duration - 0.05)), score: 1, motionScore: 1, type: "manual" };
    moments = [impact];
  } else {
    const detected = detectKeyMoments(clip, preferences);
    impact = detected.primary;
    moments = detected.moments;
  }
  // Manual markers are placed on the frame the user sees, automatic ones on the
  // kill sound, which trails the visual hit.
  const lead = impact.type === "manual" ? 0 : Math.max(0, Number(preferences.impactLead ?? IMPACT_LEAD_SECONDS));
  const anchor = clamp(impact.time - lead, 0.05, Math.max(0.05, clip.duration - 0.05));
  const firstInCluster = Math.min(...moments.filter((item) => item.time <= impact.time && impact.time - item.time <= 2.6).map((item) => item.time - lead), anchor);
  const slowSource = profile.slow ? profile.slow.length * profile.slow.speed : 0;
  const postSource = Math.max(0, clip.duration - anchor);
  // How much timeline the source can fill before/after the hit without
  // misaligning it: slower playback (≥0.9× of the style speed before the hit,
  // slow motion and a short freeze after it) stretches what is available.
  const preCapacity = anchor / (profile.base * 0.9);
  const postCapacity = (postSource >= slowSource && profile.slow
    ? profile.slow.length + (postSource - slowSource) / (profile.base * 0.6)
    : postSource / Math.min(0.6, profile.slow?.speed || 0.6)) + profile.maxFreeze;
  const clusterPre = (anchor - Math.max(0, firstInCluster)) / profile.base + 0.35;
  // Keep the slot open until the kill sound itself has played.
  const slowSourceLength = profile.slow ? profile.slow.length * profile.slow.speed : 0;
  const leadTimeline = profile.slow && lead > slowSourceLength
    ? profile.slow.length + (lead - slowSourceLength) / profile.base
    : profile.slow ? lead / profile.slow.speed : lead / profile.base;
  const idealPost = profile.idealPost === null ? null : Math.max(profile.idealPost, leadTimeline + 0.12);
  return {
    ...clip,
    impact,
    moments,
    lead,
    anchor,
    idealPost,
    preCapacity,
    postCapacity,
    minPre: Math.min(Math.max(profile.minPre, clusterPre), Math.max(profile.minPre, preCapacity))
  };
}

// Choose one music hit per clip (in order) with dynamic programming. Strong
// onsets that coincide with a reference cut are the best landing spots; every
// clip must have enough footage before and after its kill to fill its slot.
function assignHits(duration, cuts, onsets, clips, profile, preferences) {
  const count = clips.length;
  const strict = preferences.beatSync === "strict";
  const candidates = hitCandidates(duration, cuts, onsets, profile);
  const slot = duration / count;
  const idealPost = (clip) => clip.idealPost ?? slot * 0.5;
  const prePenalty = (clip, pre) => Math.max(0, clip.minPre - pre) * 3 + Math.max(0, pre - clip.preCapacity) * 2.2;
  const postPenalty = (clip, post) => Math.max(0, 0.08 - post) * 8 + Math.max(0, post - clip.postCapacity) * 2.2;
  const qualityWeight = strict ? 1.4 : 0.8;
  const evenWeight = strict ? 0.08 : 0.16;
  const M = candidates.length;
  const score = Array.from({ length: count }, () => new Float64Array(M).fill(-Infinity));
  const parent = Array.from({ length: count }, () => new Int32Array(M).fill(-1));

  for (let k = 0; k < M; k += 1) {
    const h = candidates[k].time;
    const clip = clips[0];
    let value = candidates[k].quality * qualityWeight - prePenalty(clip, h)
      - Math.abs(h - (slot - idealPost(clip))) * evenWeight;
    if (count === 1) value -= postPenalty(clip, duration - h) + Math.abs(duration - h - idealPost(clip)) * 0.35;
    score[0][k] = value;
  }
  for (let i = 1; i < count; i += 1) {
    const clip = clips[i];
    const previous = clips[i - 1];
    const target = slot * (i + 1) - idealPost(clip);
    for (let k = 0; k < M; k += 1) {
      const h = candidates[k].time;
      let best = -Infinity;
      let bestParent = -1;
      for (let j = 0; j < k; j += 1) {
        if (score[i - 1][j] === -Infinity) continue;
        const previousHit = candidates[j].time;
        const gap = h - previousHit;
        if (gap < 0.3) continue;
        const boundary = clamp(previousHit + idealPost(previous), previousHit + 0.08, h - Math.min(clip.minPre, gap * 0.6));
        const value = score[i - 1][j]
          - postPenalty(previous, boundary - previousHit)
          - prePenalty(clip, h - boundary);
        if (value > best) { best = value; bestParent = j; }
      }
      if (bestParent < 0) continue;
      let value = best + candidates[k].quality * qualityWeight - Math.abs(h - target) * evenWeight;
      if (i === count - 1) value -= postPenalty(clip, duration - h) + Math.abs(duration - h - idealPost(clip)) * 0.35;
      score[i][k] = value;
      parent[i][k] = bestParent;
    }
  }
  let end = -1;
  for (let k = 0; k < M; k += 1) if (end < 0 || score[count - 1][k] > score[count - 1][end]) end = k;
  if (end < 0 || score[count - 1][end] === -Infinity) {
    // Not enough candidate hits for every clip: fall back to evenly spaced slots.
    const macro = macroBoundaries(duration, cuts, count);
    return clips.map((clip, index) => clamp(macro[index + 1] - idealPost(clip), macro[index] + 0.3, macro[index + 1] - 0.05));
  }
  const result = new Array(count);
  for (let i = count - 1, k = end; i >= 0; i -= 1) {
    result[i] = candidates[k].time;
    k = parent[i][k];
  }
  return result;
}

function hitCandidates(duration, cuts, onsets, profile) {
  const fromBeats = onsets
    .filter((beat) => beat.time > 0.3 && beat.time < duration - 0.05)
    .map((beat) => {
      const nearCut = cuts.some((cut) => Math.abs(cut - beat.time) <= 0.12 || (cut - beat.time > 0 && cut - beat.time <= (profile.idealPost ?? 0.5) + 0.15));
      return { time: beat.time, quality: (beat.strength || 0) + (nearCut ? 0.25 : 0) };
    });
  // A coarse grid keeps the plan solvable when the music has few onsets.
  const grid = [];
  for (let time = 0.5; time < duration - 0.05; time += 0.25) {
    if (fromBeats.every((beat) => Math.abs(beat.time - time) > 0.12)) grid.push({ time, quality: -0.15 });
  }
  return [...fromBeats, ...grid].sort((a, b) => a.time - b.time);
}

function chooseBoundaries(duration, hits, clips, cuts, onsets, profile) {
  const boundaries = [0];
  for (let i = 0; i < clips.length - 1; i += 1) {
    const hit = hits[i];
    const nextHit = hits[i + 1];
    const clip = clips[i];
    const next = clips[i + 1];
    const ideal = hit + (clip.idealPost ?? (nextHit - hit) * 0.5);
    const hardLow = hit + 0.08;
    const hardHigh = Math.max(hardLow, nextHit - Math.min(0.3, (nextHit - hit) * 0.5));
    const low = Math.max(hardLow, nextHit - next.preCapacity);
    const high = Math.min(hardHigh, nextHit - Math.min(next.minPre, (nextHit - hit) * 0.6), hit + clip.postCapacity);
    let boundary = low <= high ? clamp(ideal, low, high) : clamp((low + high) / 2, hardLow, hardHigh);
    // Snap to a reference transition or a beat when one is close.
    const snapLow = low <= high ? low : hardLow;
    const snapHigh = low <= high ? high : hardHigh;
    const snap = [...cuts.map((time) => ({ time, radius: 0.2 })), ...onsets.map((beat) => ({ time: beat.time, radius: 0.1 }))]
      .filter((item) => Math.abs(item.time - boundary) <= item.radius && item.time >= snapLow && item.time <= snapHigh)
      .sort((a, b) => Math.abs(a.time - boundary) - Math.abs(b.time - boundary))[0];
    if (snap) boundary = snap.time;
    boundaries.push(clamp(boundary, Math.max(boundaries.at(-1) + 0.3, hardLow), hardHigh));
  }
  boundaries.push(duration);
  return boundaries;
}

// Builds a piecewise-linear timeline→source mapping for one clip slot:
// natural speed → quick speed-up into the kill → slow motion after it →
// natural speed, with a frozen final frame when the clip ends too early.
function mapMacro(clip, start, hit, end, profile) {
  const pieces = [];
  const base = profile.base;
  const preLength = Math.max(0, hit - start);
  const fastLength = profile.fastIn ? Math.min(profile.fastIn.length, preLength * 0.45) : 0;
  const prePieces = [
    { length: preLength - fastLength, speed: base },
    { length: fastLength, speed: profile.fastIn?.speed || base }
  ].filter((piece) => piece.length > 0.0005);
  let preSource = prePieces.reduce((sum, piece) => sum + piece.length * piece.speed, 0);
  if (preSource > clip.anchor && preSource > 0) {
    const factor = Math.max(0.9, clip.anchor / preSource);
    prePieces.forEach((piece) => { piece.speed *= factor; });
    preSource = prePieces.reduce((sum, piece) => sum + piece.length * piece.speed, 0);
  }
  const sourceStart = Math.max(0, clip.anchor - preSource);

  const postLength = Math.max(0, end - hit);
  const slowLength = profile.slow ? Math.min(profile.slow.length, postLength) : 0;
  const postPieces = [
    { length: slowLength, speed: profile.slow?.speed || base },
    { length: postLength - slowLength, speed: base }
  ].filter((piece) => piece.length > 0.0005);
  const sourceAtHit = sourceStart + preSource;
  const remaining = Math.max(0, clip.duration - 0.04 - sourceAtHit);
  const postSource = postPieces.reduce((sum, piece) => sum + piece.length * piece.speed, 0);
  if (postSource > remaining && postSource > 0) {
    const factor = Math.max(0.6, remaining / postSource);
    postPieces.forEach((piece) => { piece.speed = Math.max(0.5, piece.speed * factor); });
  }
  let time = start;
  let source = sourceStart;
  const rampPoints = [];
  for (const piece of [...prePieces, ...postPieces]) {
    pieces.push({ start: time, end: time + piece.length, source, speed: piece.speed });
    time += piece.length;
    source += piece.length * piece.speed;
    rampPoints.push(time);
  }
  rampPoints.pop();
  const sourceLimit = Math.max(0.05, clip.duration - 0.04);

  const toSource = (t) => {
    const piece = pieces.find((item) => t <= item.end + 1e-9) || pieces.at(-1);
    if (!piece) return sourceStart;
    return piece.source + (clamp(t, piece.start, piece.end) - piece.start) * piece.speed;
  };
  const toTimeline = (s) => {
    for (const piece of pieces) {
      const pieceEnd = piece.source + (piece.end - piece.start) * piece.speed;
      if (s >= piece.source - 1e-9 && s <= pieceEnd + 1e-9) return piece.start + (s - piece.source) / piece.speed;
    }
    return NaN;
  };
  const sourceRange = (from, to) => {
    const length = to - from;
    let startSource = toSource(from);
    let endSource = toSource(to);
    let freeze = 0;
    if (endSource > sourceLimit) {
      const reachesLimit = toTimeline(sourceLimit);
      freeze = Number.isFinite(reachesLimit) ? clamp(to - Math.max(from, reachesLimit), 0, length) : length;
      endSource = sourceLimit;
    }
    // A slot that is entirely frozen still needs a few real frames to clone.
    if (endSource - startSource < 0.06) {
      startSource = Math.max(0, sourceLimit - 0.12);
      endSource = sourceLimit;
      freeze = Math.max(0, length - 0.12);
    }
    const moving = Math.max(0.02, length - freeze);
    return {
      start: startSource,
      duration: endSource - startSource,
      speed: clamp((endSource - startSource) / moving, 0.5, 2.5),
      freeze
    };
  };
  const anchorTimeline = toTimeline(clip.anchor);
  return {
    toSource,
    toTimeline,
    sourceRange,
    rampPoints: rampPoints.filter((point) => point > start + 0.1 && point < end - 0.1),
    anchorTimeline: Number.isFinite(anchorTimeline) ? anchorTimeline : hit
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

module.exports = {
  clamp, createBlueprint, assignClips, chooseEffect, styleProfile, IMPACT_LEAD_SECONDS,
  createEventPlan, macroBoundaries, detectImpact, detectKeyMoments, nearestRhythmHit
};
