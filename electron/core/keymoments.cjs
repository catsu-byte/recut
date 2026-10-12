// Key-moment detection for gaming clips.
//
// A clip can contain more than one interesting event (a multi-kill, a double
// crystal tap followed by a totem pop, …). Every audio transient is scored with
// nearby visual motion and a crisp high-frequency component (hit and kill
// sounds are short and bright), then non-maximum suppression keeps distinct
// moments. Moments close to each other are grouped into a multi-kill cluster so
// the planner can show the whole sequence and land the final hit on the beat.

const MIN_MOMENT_GAP = 0.32;
const CLUSTER_GAP = 2.6;

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function searchWindow(duration, preferences = {}) {
  if (preferences.impactPosition === "end") {
    // The user told us the kill sits at the end of each trimmed clip, so the
    // loot/pickup heuristic below must not hide it. Search the final part only.
    const fromEnd = Number(preferences.impactSearchSeconds) > 0 ? Number(preferences.impactSearchSeconds) : null;
    const start = fromEnd ? duration - fromEnd : duration * 0.45;
    return { start: clamp(start, 0, duration), end: Math.max(0, duration - 0.04), lateWeight: 0.22 };
  }
  if (preferences.impactPosition === "start") {
    return { start: 0.1, end: Math.min(duration - 0.12, duration * 0.55), lateWeight: -0.08 };
  }
  // The final inventory/pickup sound is often the loudest event in a gaming
  // clip, but it happens after the elimination. Keep a short post-roll out of
  // the search so effects land on the fight instead of the loot collection.
  return { start: duration * 0.18, end: Math.min(duration - 0.12, duration * 0.92), lateWeight: 0.08 };
}

function nearest(items, time, key = "score") {
  let best = { distance: Infinity, value: 0 };
  for (const item of items) {
    const distance = Math.abs(item.time - time);
    if (distance < best.distance) best = { distance, value: item[key] || 0 };
  }
  return best;
}

function motionAt(motionCurve, motionCandidates, time) {
  const curve = motionCurve?.length ? motionCurve : motionCandidates;
  if (!curve?.length) return 0;
  const maximum = Math.max(...curve.map((item) => item.score), 0.00001);
  // Kills cause a burst of motion right around the event: look at a small
  // window instead of the single nearest sample.
  let peak = 0;
  for (const item of curve) {
    const distance = Math.abs(item.time - time);
    if (distance > 1.1) continue;
    peak = Math.max(peak, (item.score / maximum) * Math.max(0, 1 - distance / 1.1));
  }
  return peak;
}

function scoreOnsets(duration, onsets, clip, preferences, window) {
  const hfOnsets = clip.hfOnsets || [];
  return onsets
    .filter((item) => item.time >= window.start && item.time <= window.end)
    .map((onset) => {
      const motionScore = motionAt(clip.motionCurve, clip.candidates, onset.time);
      const hf = nearest(hfOnsets, onset.time, "strength");
      const crispScore = hf.distance <= 0.06 ? hf.value : 0;
      const lateBias = duration > 0 ? onset.time / duration : 0;
      const pairedOnset = preferences.detectDoubleTaps === false ? null : onsets.find((other) => {
        const gap = Math.abs(other.time - onset.time);
        return other !== onset && gap >= 0.075 && gap <= 0.46 && other.strength >= 0.28;
      });
      const doubleTapScore = pairedOnset
        ? Math.min(onset.strength, pairedOnset.strength) * Math.max(0, 1 - Math.abs(Math.abs(pairedOnset.time - onset.time) - 0.22) / 0.3)
        : 0;
      const score = onset.strength * 0.45
        + motionScore * 0.23
        + crispScore * 0.12
        + lateBias * window.lateWeight
        + doubleTapScore * 0.15;
      return {
        time: onset.time,
        score,
        motionScore,
        crispScore,
        doubleTapScore,
        type: doubleTapScore >= 0.18 ? "double-tap" : "impact"
      };
    });
}

function suppress(candidates, minimumGap = MIN_MOMENT_GAP) {
  const kept = [];
  for (const candidate of [...candidates].sort((a, b) => b.score - a.score)) {
    if (kept.every((item) => Math.abs(item.time - candidate.time) >= minimumGap)) kept.push(candidate);
  }
  return kept.sort((a, b) => a.time - b.time);
}

function clusterMoments(moments, best) {
  const strong = moments.filter((item) => item.score >= best * 0.62);
  const clusters = [];
  for (const moment of strong) {
    const current = clusters.at(-1);
    if (current && moment.time - current.at(-1).time <= CLUSTER_GAP) current.push(moment);
    else clusters.push([moment]);
  }
  return clusters;
}

function detectKeyMoments(clip, preferences = {}) {
  const duration = Number(clip.duration) || 0;
  const onsets = clip.onsets || [];
  const motionCandidates = clip.candidates || [];
  const window = searchWindow(duration, preferences);
  const scored = scoreOnsets(duration, onsets, clip, preferences, window);

  if (!scored.length) {
    const inWindow = motionCandidates.filter((item) => item.time >= window.start && item.time <= window.end);
    const fallback = [...(inWindow.length ? inWindow : motionCandidates)].sort((a, b) => b.score - a.score)[0];
    const time = fallback?.time ?? (preferences.impactPosition === "end" ? duration * 0.9 : duration * 0.8);
    const primary = { time, score: fallback?.score || 0, motionScore: fallback?.score || 0, type: "motion" };
    return { primary, moments: [primary], cluster: [primary], window };
  }

  const moments = suppress(scored);
  const best = Math.max(...moments.map((item) => item.score));
  const clusters = clusterMoments(moments, best);
  // Rank clusters by their combined energy, so three solid hits in a row beat a
  // single slightly louder sound.
  const ranked = clusters
    .map((cluster) => ({
      cluster,
      value: Math.max(...cluster.map((item) => item.score)) + 0.18 * (cluster.length - 1)
        + (preferences.impactPosition === "end" ? 0.1 * (cluster.at(-1).time / Math.max(duration, 0.001)) : 0)
    }))
    .sort((a, b) => b.value - a.value);
  const cluster = ranked[0].cluster;
  // In a multi-kill, the final elimination gets the big beat-synced hit while
  // earlier kills become accents. For single events pick the strongest.
  const primaryBase = cluster.length > 1 && cluster.filter((item) => item.score >= best * 0.75).length > 1
    ? [...cluster].reverse().find((item) => item.score >= best * 0.75)
    : [...cluster].sort((a, b) => b.score - a.score)[0];
  const isMulti = cluster.length >= 2 && cluster.at(-1).time - cluster[0].time >= 0.5;
  const primary = {
    ...primaryBase,
    type: primaryBase.type === "double-tap" ? "double-tap" : isMulti ? "multi-kill" : primaryBase.type,
    clusterSize: cluster.length
  };
  const strongMoments = moments
    .filter((item) => item.score >= best * 0.55)
    .map((item) => (item.time === primary.time ? primary : item));
  return { primary, moments: strongMoments, cluster, window };
}

// Compatibility wrapper: callers that only need one key moment per clip.
function detectImpact(duration, onsets, motionCandidates, preferences = {}) {
  return detectKeyMoments({ duration, onsets, candidates: motionCandidates }, preferences).primary;
}

module.exports = { detectKeyMoments, detectImpact, searchWindow };
