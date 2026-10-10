const fs = require("node:fs/promises");
const path = require("node:path");
const { run, probe, sceneCuts, audioOnsets, findAudioOffset, motionWindows, FFMPEG, FFPROBE } = require("./media.cjs");
const { clamp, createEventPlan } = require("./planner.cjs");
const { createFcpxml, createReport } = require("./exporters.cjs");

async function assertToolchain() {
  await Promise.all([run(FFMPEG, ["-version"]), run(FFPROBE, ["-version"])]);
}

function validateInput(input, { requireOutput = true } = {}) {
  if (!input?.referencePath) throw new Error("Choose a reference edit first.");
  if (!Array.isArray(input.clipPaths) || input.clipPaths.length < 1) throw new Error("Choose at least one gaming clip.");
  if (requireOutput && !input.outputDirectory) throw new Error("Choose an output folder.");
}

async function inspectProject(input) {
  validateInput(input, { requireOutput: false });
  const reference = await probe(input.referencePath);
  const targetDuration = montageDuration(input.duration, reference.duration);
  const audioMatch = input.musicPath
    ? await findAudioOffset(input.referencePath, input.musicPath, targetDuration)
    : { offset: 0, confidence: 1 };
  const [cuts, onsets, clips] = await Promise.all([
    sceneCuts(input.referencePath, targetDuration, 0.08),
    audioOnsets(input.musicPath || input.referencePath, targetDuration, audioMatch.offset),
    Promise.all(input.clipPaths.map(async (clipPath) => {
      const info = await probe(clipPath);
      const [candidates, clipOnsets] = await Promise.all([
        motionWindows(clipPath, info.duration),
        audioOnsets(clipPath, info.duration)
      ]);
      return { ...info, candidates, onsets: clipOnsets };
    }))
  ]);
  const blueprint = createEventPlan({ duration: targetDuration, cuts, onsets, clips });
  return { ...summarize(blueprint, blueprint.segments, reference), musicOffset: audioMatch.offset, musicMatchConfidence: audioMatch.confidence };
}

async function renderProject(input, progress = () => {}) {
  validateInput(input);
  progress({ stage: "reference", percent: 3, message: "Reading the reference edit" });
  const reference = await probe(input.referencePath);
  const targetDuration = montageDuration(input.duration, reference.duration);

  progress({ stage: "reference", percent: 7, message: "Matching the reference music section" });
  const audioMatch = input.musicPath
    ? await findAudioOffset(input.referencePath, input.musicPath, targetDuration)
    : { offset: 0, confidence: 1 };

  progress({ stage: "reference", percent: 12, message: "Detecting reference cuts and rhythm" });
  const [cuts, onsets] = await Promise.all([
    sceneCuts(input.referencePath, targetDuration, 0.08),
    audioOnsets(input.musicPath || input.referencePath, targetDuration, audioMatch.offset)
  ]);

  progress({ stage: "clips", percent: 18, message: `Scanning ${input.clipPaths.length} gaming clips` });
  const clips = [];
  for (let index = 0; index < input.clipPaths.length; index += 1) {
    const clipPath = input.clipPaths[index];
    const info = await probe(clipPath);
    const [candidates, clipOnsets] = await Promise.all([
      motionWindows(clipPath, info.duration),
      audioOnsets(clipPath, info.duration)
    ]);
    clips.push({ ...info, candidates, onsets: clipOnsets });
    progress({
      stage: "clips",
      percent: 18 + Math.round(((index + 1) / input.clipPaths.length) * 20),
      message: `Scanned clip ${index + 1} of ${input.clipPaths.length}`
    });
  }
  const blueprint = createEventPlan({ duration: targetDuration, cuts, onsets, clips });
  const plan = blueprint.segments;
  const { width, height, fps } = outputProfile(clips, input.aspectRatio);
  const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const projectDirectory = path.join(input.outputDirectory, `recut-${stamp}`);
  const segmentDirectory = path.join(projectDirectory, "segments");
  await fs.mkdir(segmentDirectory, { recursive: true });

  progress({ stage: "render", percent: 40, message: `Rendering ${plan.length} matched segments` });
  const renderedPlan = [];
  for (let index = 0; index < plan.length; index += 1) {
    const segment = plan[index];
    const renderedPath = path.join(segmentDirectory, `segment-${String(index + 1).padStart(3, "0")}.mp4`);
    await renderSegment(segment, renderedPath, { width, height, fps });
    renderedPlan.push({ ...segment, renderedPath });
    progress({
      stage: "render",
      percent: 40 + Math.round(((index + 1) / plan.length) * 42),
      message: `Rendered segment ${index + 1} of ${plan.length}`
    });
  }

  progress({ stage: "assemble", percent: 84, message: "Assembling preview and music" });
  const previewPath = path.join(projectDirectory, "recut-preview.mp4");
  const audioPath = input.musicPath || input.referencePath;
  await concatenate(renderedPlan, previewPath, audioPath, audioMatch.offset, targetDuration, projectDirectory);

  progress({ stage: "export", percent: 94, message: "Writing the DaVinci Resolve timeline" });
  const timelinePath = path.join(projectDirectory, "recut-timeline.fcpxml");
  const reportPath = path.join(projectDirectory, "recut-report.json");
  await Promise.all([
    fs.writeFile(timelinePath, createFcpxml({ segments: renderedPlan, musicPath: audioPath, musicOffset: audioMatch.offset, width, height, fps }), "utf8"),
    fs.writeFile(reportPath, JSON.stringify(createReport({
      blueprint,
      plan: renderedPlan,
      referencePath: input.referencePath,
      musicPath: audioPath,
      musicOffset: audioMatch.offset,
      musicMatchConfidence: audioMatch.confidence,
      outputProfile: { width, height, fps },
      outputPath: previewPath
    }), null, 2), "utf8")
  ]);
  progress({ stage: "done", percent: 100, message: "Your montage is ready" });
  return {
    ...summarize(blueprint, renderedPlan, reference),
    projectDirectory,
    previewPath,
    timelinePath,
    reportPath,
    musicOffset: audioMatch.offset,
    musicMatchConfidence: audioMatch.confidence,
    outputProfile: { width, height, fps }
  };
}

function outputProfile(clips, aspectRatio) {
  const valid = clips.filter((clip) => clip.width > 0 && clip.height > 0);
  const sourceWidth = Math.min(...valid.map((clip) => clip.width), 1920);
  const sourceHeight = Math.min(...valid.map((clip) => clip.height), 1080);
  const fps = Math.max(24, Math.min(60, Math.floor(Math.min(...valid.map((clip) => clip.fps || 30)))));
  if (aspectRatio === "9:16") {
    const height = Math.min(sourceHeight || 1920, 1920);
    return { width: Math.max(360, Math.round((height * 9) / 16 / 2) * 2), height, fps };
  }
  const width = Math.min(sourceWidth || 1920, 1920);
  return { width, height: Math.max(360, Math.round((width * 9) / 16 / 2) * 2), fps };
}

function montageDuration(requestedDuration, referenceDuration) {
  if (!Number.isFinite(referenceDuration) || referenceDuration <= 0.05) {
    throw new Error("The reference edit has no readable duration. Re-export or remux it to MP4 and try again.");
  }
  const maximum = Math.min(45, referenceDuration);
  const minimum = Math.min(15, maximum);
  return clamp(Number(requestedDuration) || Math.min(referenceDuration, 30), minimum, maximum);
}

async function renderSegment(segment, outputPath, { width, height, fps }) {
  const base = `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`;
  const speed = `setpts=PTS/${segment.speed}`;
  const filters = effectFilters(segment.effect, base, width, height, segment.duration);
  await run(FFMPEG, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-ss", segment.sourceStart.toFixed(3), "-t", segment.sourceDuration.toFixed(3),
    "-i", segment.sourcePath,
    "-vf", `${filters},${speed},fps=${fps},format=yuv420p`,
    "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "16",
    "-t", segment.duration.toFixed(3), outputPath
  ]);
}

function effectFilters(effect, base, width, height, duration) {
  if (effect === "push") {
    return `${base},scale=w='iw*(1+0.035*t/${Math.max(duration, 0.2)})':h='ih*(1+0.035*t/${Math.max(duration, 0.2)})':eval=frame,crop=${width}:${height}`;
  }
  if (effect === "punch") {
    return `${base},scale=${Math.ceil(width * 1.06)}:${Math.ceil(height * 1.06)},crop=${width}:${height}`;
  }
  if (effect === "shake") {
    return `${base},scale=${width + 36}:${height + 36},crop=${width}:${height}:x='18+10*sin(45*t)':y='18+8*cos(39*t)'`;
  }
  if (effect === "flash") {
    return `${base},eq=brightness='if(lt(t,0.11),0.55*(1-t/0.11),0)':eval=frame`;
  }
  if (effect === "drift") {
    return `${base},scale=${width + 24}:${height + 24},crop=${width}:${height}:x='12+8*sin(1.2*t)':y='12+6*cos(1.05*t)'`;
  }
  return base;
}

async function concatenate(plan, outputPath, audioPath, audioOffset, duration, workingDirectory) {
  const concatPath = path.join(workingDirectory, "segments.txt");
  const lines = plan.map((segment) => `file '${segment.renderedPath.replaceAll("'", "'\\''").replaceAll("\\", "/")}'`);
  await fs.writeFile(concatPath, `${lines.join("\n")}\n`, "utf8");
  await run(FFMPEG, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "concat", "-safe", "0", "-i", concatPath,
    "-ss", Math.max(0, audioOffset).toFixed(3), "-i", audioPath,
    "-map", "0:v:0", "-map", "1:a:0?",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "256k",
    "-af", `afade=t=out:st=${Math.max(0, duration - 0.35).toFixed(3)}:d=0.35`,
    "-t", duration.toFixed(3), "-movflags", "+faststart", outputPath
  ]);
}

function summarize(blueprint, plan, reference) {
  const effects = plan.reduce((result, item) => {
    result[item.effect] = (result[item.effect] || 0) + 1;
    return result;
  }, {});
  return {
    duration: blueprint.duration,
    segments: plan.length,
    cuts: blueprint.cuts.length,
    detectedSceneCuts: blueprint.detectedSceneCuts,
    detectedBeats: blueprint.detectedBeats,
    effects,
    reference: { duration: reference.duration, width: reference.width, height: reference.height }
  };
}

module.exports = { assertToolchain, inspectProject, renderProject, effectFilters, montageDuration, outputProfile };
