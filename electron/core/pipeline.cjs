const fs = require("node:fs/promises");
const path = require("node:path");
const { run, probe, sceneCuts, audioOnsets, findAudioOffset, motionWindows, FFMPEG, FFPROBE } = require("./media.cjs");
const { clamp, createEventPlan } = require("./planner.cjs");
const { createFcpxml, createReport } = require("./exporters.cjs");
const { transcribeMusicSection, matchMusicSection } = require("./transcriber.cjs");
const { createLyricCaptionPlan, createAss } = require("./captions.cjs");

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
    ? await matchAudio(input.referencePath, input.musicPath, targetDuration)
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
    ? await matchAudio(input.referencePath, input.musicPath, targetDuration)
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

  const audioPath = input.musicPath || input.referencePath;
  progress({ stage: "captions", percent: 39, message: "Transcribing the matched song section for lyric captions" });
  const transcription = await transcribeMusicSection(audioPath, audioMatch.offset, targetDuration, projectDirectory);
  const captionPlan = createLyricCaptionPlan(plan, transcription.transcript);
  const captionsPath = path.join(projectDirectory, "recut-captions.ass");
  await fs.writeFile(captionsPath, createAss(captionPlan, { width, height }), "utf8");

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
  const basePreviewPath = path.join(projectDirectory, "recut-base.mp4");
  await concatenate(renderedPlan, basePreviewPath, audioPath, audioMatch.offset, targetDuration, projectDirectory);

  progress({ stage: "captions", percent: 90, message: captionPlan.captions.length ? "Styling subtitles and impact words" : "No reliable speech found — keeping the edit text-free" });
  if (captionPlan.captions.length) await burnCaptions(basePreviewPath, previewPath, captionsPath);
  else await fs.copyFile(basePreviewPath, previewPath);

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
      musicMatchMethod: audioMatch.method,
      outputProfile: { width, height, fps },
      captions: {
        status: transcription.status,
        model: transcription.model,
        source: "matched music section",
        error: transcription.error || null,
        phrases: captionPlan.captions.length,
        keywords: captionPlan.keywords.length,
        path: captionsPath
      },
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
    captionsPath,
    captions: { status: transcription.status, phrases: captionPlan.captions.length, keywords: captionPlan.keywords.length },
    musicOffset: audioMatch.offset,
    musicMatchConfidence: audioMatch.confidence,
    musicMatchMethod: audioMatch.method,
    outputProfile: { width, height, fps }
  };
}

function outputProfile(clips, aspectRatio) {
  const valid = clips.filter((clip) => clip.width > 0 && clip.height > 0);
  const sourceWidth = Math.min(...valid.map((clip) => clip.width), 1920);
  const sourceHeight = Math.min(...valid.map((clip) => clip.height), 1080);
  const fps = Math.max(24, Math.min(60, Math.floor(Math.min(...valid.map((clip) => clip.fps || 30)))));
  if (aspectRatio === "9:16") {
    const height = Math.min(Math.max(sourceHeight || 1280, 1280), 1920);
    return { width: Math.round((height * 9) / 16 / 2) * 2, height, fps };
  }
  const width = Math.min(Math.max(sourceWidth || 1280, 1280), 1920);
  return { width, height: Math.round((width * 9) / 16 / 2) * 2, fps };
}

function montageDuration(requestedDuration, referenceDuration) {
  if (!Number.isFinite(referenceDuration) || referenceDuration <= 0.05) {
    throw new Error("The reference edit has no readable duration. Re-export or remux it to MP4 and try again.");
  }
  const maximum = Math.min(45, referenceDuration);
  const minimum = Math.min(15, maximum);
  return clamp(Number(requestedDuration) || Math.min(referenceDuration, 30), minimum, maximum);
}

async function matchAudio(referencePath, musicPath, duration) {
  const spectral = await matchMusicSection(referencePath, musicPath, duration);
  if (Number.isFinite(spectral.offset) && spectral.confidence >= 0.35) return spectral;
  const fallback = await findAudioOffset(referencePath, musicPath, duration);
  return { ...fallback, method: "envelope" };
}

async function renderSegment(segment, outputPath, { width, height, fps }) {
  const base = `scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${width}:${height}`;
  const filters = effectFilters(segment, base, width, height, segment.duration);
  await run(FFMPEG, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-ss", segment.sourceStart.toFixed(3), "-t", segment.sourceDuration.toFixed(3),
    "-i", segment.sourcePath,
    "-vf", `${filters},fps=${fps},format=yuv420p`,
    "-af", `atempo=${segment.speed.toFixed(5)}`,
    "-map", "0:v:0", "-map", "0:a:0?",
    "-c:v", "libx264", "-preset", "medium", "-crf", "16",
    "-c:a", "aac", "-b:a", "160k", "-ac", "2",
    "-t", segment.duration.toFixed(3), outputPath
  ]);
}

function effectFilters(effectOrSegment, base, width, height, duration) {
  const segment = typeof effectOrSegment === "string"
    ? { effect: effectOrSegment, sourceStart: 0, impactTime: 0.18, speed: 1 }
    : effectOrSegment;
  const effect = segment.effect;
  const speed = `setpts=PTS/${Math.max(segment.speed || 1, 0.01)}`;
  const impact = clamp((segment.impactTime - segment.sourceStart) / Math.max(segment.speed || 1, 0.01), 0.04, Math.max(0.05, duration - 0.04));
  const hitStart = Math.max(0, impact - 0.055).toFixed(3);
  const hitEnd = Math.min(duration, impact + 0.16).toFixed(3);
  const grade = "hqdn3d=0.7:0.7:2.8:2.8,unsharp=5:5:1.15:3:3:0.3,eq=saturation=0.74:contrast=1.055:gamma=0.98,vignette=PI/5.7";
  const impactStack = `scale=${width + 32}:${height + 18},crop=${width}:${height}:x='(in_w-out_w)/2+if(between(t,${hitStart},${hitEnd}),7*sin(92*t),0)':y='(in_h-out_h)/2+if(between(t,${hitStart},${hitEnd}),5*cos(79*t),0)',rgbashift=rh=4:bh=-4:edge=wrap:enable='between(t,${hitStart},${hitEnd})',gblur=sigma=1.1:enable='between(t,${hitStart},${impact.toFixed(3)})',eq=brightness=0.24:enable='between(t,${impact.toFixed(3)},${Math.min(duration, impact + 0.075).toFixed(3)})'`;
  if (effect === "impact") return `${base},${speed},${grade},${impactStack}`;
  if (effect === "glitch") {
    const pulseStart = Math.max(0.05, duration * 0.64).toFixed(3);
    const pulseEnd = Math.min(duration, duration * 0.72).toFixed(3);
    return `${base},${speed},${grade},rgbashift=rh=3:gv=1:bh=-3:edge=wrap:enable='between(t,${pulseStart},${pulseEnd})'`;
  }
  if (effect === "push") {
    return `${base},${speed},${grade},scale=w='iw*(1+0.025*t/${Math.max(duration, 0.2)})':h='ih*(1+0.025*t/${Math.max(duration, 0.2)})':eval=frame,crop=${width}:${height}`;
  }
  if (effect === "punch") {
    return `${base},${speed},${grade},scale=${Math.ceil(width * 1.06)}:${Math.ceil(height * 1.06)},crop=${width}:${height}`;
  }
  if (effect === "shake") {
    return `${base},${speed},${grade},scale=${width + 36}:${height + 36},crop=${width}:${height}:x='18+10*sin(45*t)':y='18+8*cos(39*t)'`;
  }
  if (effect === "flash") {
    return `${base},${speed},${grade},eq=brightness='if(lt(t,0.11),0.55*(1-t/0.11),0)':eval=frame`;
  }
  if (effect === "drift") {
    return `${base},${speed},${grade},scale=${width + 20}:${height + 12},crop=${width}:${height}:x='10+5*sin(1.1*t)':y='6+4*cos(0.9*t)'`;
  }
  return `${base},${speed},${grade}`;
}

async function concatenate(plan, outputPath, audioPath, audioOffset, duration, workingDirectory) {
  const concatPath = path.join(workingDirectory, "segments.txt");
  const lines = plan.map((segment) => `file '${segment.renderedPath.replaceAll("'", "'\\''").replaceAll("\\", "/")}'`);
  await fs.writeFile(concatPath, `${lines.join("\n")}\n`, "utf8");
  await run(FFMPEG, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "concat", "-safe", "0", "-i", concatPath,
    "-ss", Math.max(0, audioOffset).toFixed(3), "-i", audioPath,
    "-filter_complex", `[0:a:0]volume=0.72[source];[1:a:0]volume=0.82[music];[source][music]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95,afade=t=out:st=${Math.max(0, duration - 0.35).toFixed(3)}:d=0.35[mix]`,
    "-map", "0:v:0", "-map", "[mix]",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "256k",
    "-t", duration.toFixed(3), "-movflags", "+faststart", outputPath
  ]);
}

async function burnCaptions(inputPath, outputPath, captionsPath) {
  const filterPath = captionsPath.replaceAll("\\", "/").replace(":", "\\:").replaceAll("'", "\\'");
  await run(FFMPEG, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", inputPath,
    "-vf", `ass='${filterPath}'`,
    "-map", "0:v:0", "-map", "0:a:0?",
    "-c:v", "libx264", "-preset", "medium", "-crf", "16",
    "-c:a", "copy", "-movflags", "+faststart", outputPath
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
