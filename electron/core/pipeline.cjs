const fs = require("node:fs/promises");
const path = require("node:path");
const { run, probe, sceneCuts, audioOnsets, motionWindows, FFMPEG, FFPROBE } = require("./media.cjs");
const { clamp, createBlueprint, assignClips } = require("./planner.cjs");
const { createFcpxml, createReport } = require("./exporters.cjs");

async function assertToolchain() {
  await Promise.all([run(FFMPEG, ["-version"]), run(FFPROBE, ["-version"])]);
}

function validateInput(input) {
  if (!input?.referencePath) throw new Error("Choose a reference edit first.");
  if (!Array.isArray(input.clipPaths) || input.clipPaths.length < 2) throw new Error("Choose at least two gaming clips.");
  if (!input.outputDirectory) throw new Error("Choose an output folder.");
}

async function inspectProject(input) {
  validateInput(input);
  const reference = await probe(input.referencePath);
  const targetDuration = clamp(Number(input.duration) || Math.min(reference.duration, 30), 15, Math.min(45, reference.duration));
  const [cuts, onsets, clips] = await Promise.all([
    sceneCuts(input.referencePath, targetDuration),
    audioOnsets(input.musicPath || input.referencePath, targetDuration),
    Promise.all(input.clipPaths.map(async (clipPath) => {
      const info = await probe(clipPath);
      return { ...info, candidates: await motionWindows(clipPath, info.duration) };
    }))
  ]);
  const blueprint = createBlueprint({ duration: targetDuration, cuts, onsets });
  const plan = assignClips(blueprint, clips);
  return summarize(blueprint, plan, reference);
}

async function renderProject(input, progress = () => {}) {
  validateInput(input);
  progress({ stage: "reference", percent: 3, message: "Reading the reference edit" });
  const reference = await probe(input.referencePath);
  const targetDuration = clamp(Number(input.duration) || Math.min(reference.duration, 30), 15, Math.min(45, reference.duration));
  const width = input.aspectRatio === "9:16" ? 1080 : 1920;
  const height = input.aspectRatio === "9:16" ? 1920 : 1080;
  const fps = 30;

  progress({ stage: "reference", percent: 8, message: "Detecting cuts and audio peaks" });
  const [cuts, onsets] = await Promise.all([
    sceneCuts(input.referencePath, targetDuration),
    audioOnsets(input.musicPath || input.referencePath, targetDuration)
  ]);
  const blueprint = createBlueprint({ duration: targetDuration, cuts, onsets });

  progress({ stage: "clips", percent: 18, message: `Scanning ${input.clipPaths.length} gaming clips` });
  const clips = [];
  for (let index = 0; index < input.clipPaths.length; index += 1) {
    const clipPath = input.clipPaths[index];
    const info = await probe(clipPath);
    const candidates = await motionWindows(clipPath, info.duration);
    clips.push({ ...info, candidates });
    progress({
      stage: "clips",
      percent: 18 + Math.round(((index + 1) / input.clipPaths.length) * 20),
      message: `Scanned clip ${index + 1} of ${input.clipPaths.length}`
    });
  }
  const plan = assignClips(blueprint, clips);
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
  await concatenate(renderedPlan, previewPath, audioPath, targetDuration, projectDirectory);

  progress({ stage: "export", percent: 94, message: "Writing the DaVinci Resolve timeline" });
  const timelinePath = path.join(projectDirectory, "recut-timeline.fcpxml");
  const reportPath = path.join(projectDirectory, "recut-report.json");
  await Promise.all([
    fs.writeFile(timelinePath, createFcpxml({ segments: renderedPlan, musicPath: audioPath, width, height, fps }), "utf8"),
    fs.writeFile(reportPath, JSON.stringify(createReport({ blueprint, plan: renderedPlan, referencePath: input.referencePath, musicPath: audioPath, outputPath: previewPath }), null, 2), "utf8")
  ]);
  progress({ stage: "done", percent: 100, message: "Your montage is ready" });
  return {
    ...summarize(blueprint, renderedPlan, reference),
    projectDirectory,
    previewPath,
    timelinePath,
    reportPath
  };
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
    "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "19",
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

async function concatenate(plan, outputPath, audioPath, duration, workingDirectory) {
  const concatPath = path.join(workingDirectory, "segments.txt");
  const lines = plan.map((segment) => `file '${segment.renderedPath.replaceAll("'", "'\\''").replaceAll("\\", "/")}'`);
  await fs.writeFile(concatPath, `${lines.join("\n")}\n`, "utf8");
  await run(FFMPEG, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "concat", "-safe", "0", "-i", concatPath,
    "-i", audioPath,
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

module.exports = { assertToolchain, inspectProject, renderProject, effectFilters };
