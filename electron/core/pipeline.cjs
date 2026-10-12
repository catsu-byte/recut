const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { run, probe, sceneCuts, audioOnsets, findAudioOffset, motionWindows, thumbnailDataUrl, FFMPEG, FFPROBE } = require("./media.cjs");
const { clamp, createEventPlan, detectImpact } = require("./planner.cjs");
const { createFcpxml, createReport } = require("./exporters.cjs");
const { transcribeMusicSection, matchMusicSection } = require("./transcriber.cjs");
const { createLyricCaptionPlan, createAss } = require("./captions.cjs");
const { loadTimedLyrics } = require("./lyrics.cjs");
const { parseEditInstructions } = require("./instructions.cjs");

const analysisCache = new Map();
const ANALYSIS_CACHE_LIMIT = 4;

async function assertToolchain() {
  await Promise.all([run(FFMPEG, ["-version"]), run(FFPROBE, ["-version"])]);
}

function validateInput(input, { requireOutput = true } = {}) {
  if (!input?.referencePath) throw new Error("Choose a reference edit first.");
  if (!Array.isArray(input.clipPaths) || input.clipPaths.length < 1) throw new Error("Choose at least one gaming clip.");
  if (requireOutput && !input.outputDirectory) throw new Error("Choose an output folder.");
  if (input.fontPath && ![".ttf", ".otf"].includes(path.extname(input.fontPath).toLowerCase())) {
    throw new Error("Custom fonts must be TTF or OTF files.");
  }
  if (input.overlayPath && ![".png", ".webp", ".jpg", ".jpeg"].includes(path.extname(input.overlayPath).toLowerCase())) {
    throw new Error("Overlay assets must be PNG, WebP or JPEG images.");
  }
}

async function inspectProject(input) {
  validateInput(input, { requireOutput: false });
  const instructions = parseEditInstructions(input.instructions);
  const scanned = recallAnalysis(input) || await scanProject(input);
  const preferences = planningPreferences(input, instructions);
  const blueprint = createEventPlan({ ...scanned, preferences });
  const analysisId = rememberAnalysis(input, scanned);
  const clipInsights = await Promise.all(scanned.clips.map(async (clip) => {
    const override = Number(preferences.impactOverrides?.[clip.path]);
    const impact = Number.isFinite(override)
      ? { time: override, score: 1, type: "manual" }
      : detectImpact(clip.duration, clip.onsets, clip.candidates, preferences);
    let thumbnail = null;
    try { thumbnail = await thumbnailDataUrl(clip.path, impact.time); } catch { /* review still works without thumbnails */ }
    return {
      path: clip.path,
      name: path.basename(clip.path),
      duration: clip.duration,
      impactTime: impact.time,
      impactScore: impact.score,
      keyMomentType: impact.type,
      fromMedal: clip.fromMedal,
      thumbnail
    };
  }));
  return {
    ...summarize(blueprint, blueprint.segments, scanned.reference),
    analysisId,
    clipInsights,
    timeline: blueprint.segments.map(publicSegment),
    instructions,
    musicOffset: scanned.audioMatch.offset,
    musicMatchConfidence: scanned.audioMatch.confidence
  };
}

async function renderProject(input, progress = () => {}, signal = null) {
  validateInput(input);
  throwIfAborted(signal);
  const instructions = parseEditInstructions(input.instructions);
  let scanned = recallAnalysis(input);
  if (scanned) {
    progress({ stage: "clips", percent: 38, message: "Reusing reviewed analysis" });
  } else {
    progress({ stage: "reference", percent: 3, message: "Reading reference, rhythm and clips" });
    scanned = await scanProject(input, progress);
  }
  throwIfAborted(signal);
  const { reference, targetDuration, audioMatch, cuts, onsets, clips } = scanned;
  const preferences = planningPreferences(input, instructions);
  const blueprint = createEventPlan({ duration: targetDuration, cuts, onsets, clips, preferences });
  const plan = blueprint.segments.map((segment) => ({
    ...segment,
    removeMedalWatermark: segment.fromMedal && (input.removeMedalWatermark || instructions.preferences.removeMedalWatermark)
  }));
  const { width, height, fps } = outputProfile(clips, input.aspectRatio, input.renderQuality);
  const encoding = encodingProfile(input.renderQuality);
  const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const projectDirectory = path.join(input.outputDirectory, `recut-${stamp}`);
  const segmentDirectory = path.join(projectDirectory, "segments");
  await fs.mkdir(segmentDirectory, { recursive: true });

  const audioPath = input.musicPath || input.referencePath;
  progress({ stage: "captions", percent: 39, message: "Transcribing the matched song section for lyric captions" });
  const transcription = input.lyricsPath
    ? {
        status: "provided",
        model: "timed lyrics",
        transcript: await loadTimedLyrics(input.lyricsPath, targetDuration, audioMatch.offset)
      }
    : await transcribeMusicSection(audioPath, audioMatch.offset, targetDuration, projectDirectory);
  const captionPlan = createLyricCaptionPlan(plan, transcription.transcript);
  const captionsPath = path.join(projectDirectory, "recut-captions.ass");
  const customFontName = input.fontName?.trim();
  await fs.writeFile(captionsPath, createAss(captionPlan, {
    width, height,
    fontName: customFontName || "Arial",
    keywordFontName: customFontName || "Bebas Neue"
  }), "utf8");

  progress({ stage: "render", percent: 40, message: `Rendering ${plan.length} matched segments` });
  const renderedPlan = [];
  for (let index = 0; index < plan.length; index += 1) {
    const segment = plan[index];
    throwIfAborted(signal);
    const renderedPath = path.join(segmentDirectory, `segment-${String(index + 1).padStart(3, "0")}.mp4`);
    await renderSegment(segment, renderedPath, { width, height, fps, encoding, signal });
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
  throwIfAborted(signal);
  const audioMix = {
    sourceVolume: clamp(Number(input.sourceVolume ?? 0.72), 0, 1.5),
    musicVolume: clamp(Number(input.musicVolume ?? 0.82), 0, 1.5)
  };
  await concatenate(renderedPlan, basePreviewPath, audioPath, audioMatch.offset, targetDuration, projectDirectory, signal, audioMix);

  progress({ stage: "captions", percent: 90, message: captionPlan.captions.length ? "Styling subtitles and impact words" : "No reliable speech found — keeping the edit text-free" });
  if (captionPlan.captions.length || input.overlayPath) await decoratePreview(basePreviewPath, previewPath, {
    captionsPath: captionPlan.captions.length ? captionsPath : null,
    overlayPath: input.overlayPath,
    overlayPosition: input.overlayPosition,
    fontPath: input.fontPath,
    width,
    encoding,
    signal
  });
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
        source: input.lyricsPath ? "provided timed lyrics" : "matched music section",
        error: transcription.error || null,
        phrases: captionPlan.captions.length,
        keywords: captionPlan.keywords.length,
        path: captionsPath
      },
      instructions,
      customAssets: { fontPath: input.fontPath || null, fontName: customFontName || null, overlayPath: input.overlayPath || null },
      editingStyle: input.editingStyle || "balanced",
      renderQuality: input.renderQuality || "standard",
      audioMix,
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

async function scanProject(input, progress = () => {}) {
  const reference = await probe(input.referencePath);
  if (!reference.hasAudio && !input.musicPath) {
    throw new Error("The reference has no audio track. Choose a music file so ReCut can detect rhythm.");
  }
  const targetDuration = montageDuration(input.duration, reference.duration);
  const audioMatch = input.musicPath
    ? await matchAudio(input.referencePath, input.musicPath, targetDuration)
    : { offset: 0, confidence: 1 };
  const [cuts, onsets, clips] = await Promise.all([
    sceneCuts(input.referencePath, targetDuration, 0.08),
    audioOnsets(input.musicPath || input.referencePath, targetDuration, audioMatch.offset),
    Promise.all(input.clipPaths.map(async (clipPath, index) => {
      const info = await probe(clipPath);
      const [candidates, clipOnsets] = await Promise.all([
        motionWindows(clipPath, info.duration), info.hasAudio ? audioOnsets(clipPath, info.duration) : Promise.resolve([])
      ]);
      progress({
        stage: "clips", percent: 18 + Math.round(((index + 1) / input.clipPaths.length) * 20),
        message: `Scanned clip ${index + 1} of ${input.clipPaths.length}`
      });
      return { ...info, candidates, onsets: clipOnsets, fromMedal: input.medalClipPaths?.includes(clipPath) };
    }))
  ]);
  return { reference, targetDuration, duration: targetDuration, audioMatch, cuts, onsets, clips };
}

function planningPreferences(input, instructions) {
  return {
    ...instructions.preferences,
    beatSync: input.editingStyle === "aggressive" ? "strict" : instructions.preferences.beatSync,
    editingStyle: ["balanced", "aggressive", "cinematic"].includes(input.editingStyle) ? input.editingStyle : "balanced",
    impactOverrides: input.impactOverrides || {}
  };
}

function analysisSignature(input) {
  return JSON.stringify({
    referencePath: input.referencePath, musicPath: input.musicPath || "", duration: Number(input.duration),
    clipPaths: input.clipPaths, medalClipPaths: input.medalClipPaths || []
  });
}

function rememberAnalysis(input, scanned) {
  const id = randomUUID();
  analysisCache.set(id, { signature: analysisSignature(input), scanned });
  while (analysisCache.size > ANALYSIS_CACHE_LIMIT) analysisCache.delete(analysisCache.keys().next().value);
  return id;
}

function recallAnalysis(input) {
  const cached = input.analysisId && analysisCache.get(input.analysisId);
  return cached?.signature === analysisSignature(input) ? cached.scanned : null;
}

function publicSegment(segment) {
  return {
    index: segment.index, clipIndex: segment.clipIndex, timelineStart: segment.timelineStart,
    duration: segment.duration, sourceName: segment.sourceName, sourceStart: segment.sourceStart,
    impactTime: segment.impactTime, hitTargetTime: segment.hitTargetTime, hitSyncError: segment.hitSyncError,
    effect: segment.effect, keyMomentType: segment.keyMomentType
  };
}

function outputProfile(clips, aspectRatio, quality = "standard") {
  const valid = clips.filter((clip) => clip.width > 0 && clip.height > 0);
  const widthCap = quality === "master" ? 3840 : quality === "draft" ? 1280 : 1920;
  const heightCap = quality === "master" ? 2160 : quality === "draft" ? 720 : 1080;
  const sourceWidth = Math.min(...valid.map((clip) => clip.width), widthCap);
  const sourceHeight = Math.min(...valid.map((clip) => clip.height), heightCap);
  const fps = Math.max(24, Math.min(60, Math.floor(Math.min(...valid.map((clip) => clip.fps || 30)))));
  const maximum = quality === "master" ? 3840 : quality === "draft" ? 1280 : 1920;
  const minimum = quality === "draft" ? 960 : 1280;
  if (aspectRatio === "9:16") {
    const height = Math.min(Math.max(sourceHeight || minimum, minimum), maximum);
    return { width: Math.round((height * 9) / 16 / 2) * 2, height, fps };
  }
  const width = Math.min(Math.max(sourceWidth || minimum, minimum), maximum);
  return { width, height: Math.round((width * 9) / 16 / 2) * 2, fps };
}

function encodingProfile(quality = "standard") {
  if (quality === "draft") return { preset: "veryfast", crf: 24, audioBitrate: "128k" };
  if (quality === "master") return { preset: "slow", crf: 14, audioBitrate: "256k" };
  return { preset: "medium", crf: 16, audioBitrate: "160k" };
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

async function renderSegment(segment, outputPath, { width, height, fps, encoding = encodingProfile(), signal = null }) {
  const watermarkCrop = segment.removeMedalWatermark
    ? "crop=trunc(iw*0.94/2)*2:trunc(ih*0.92/2)*2:(iw-ow)/2:(ih-oh)/2,"
    : "";
  const base = `${watermarkCrop}scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${width}:${height}`;
  const filters = effectFilters(segment, base, width, height, segment.duration);
  const args = [
    "-hide_banner", "-loglevel", "error", "-y",
    "-ss", segment.sourceStart.toFixed(3), "-t", segment.sourceDuration.toFixed(3),
    "-i", segment.sourcePath
  ];
  if (!segment.hasAudio) args.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
  args.push(
    "-vf", `${filters},fps=${fps},format=yuv420p`,
    "-af", `atempo=${segment.speed.toFixed(5)}`,
    "-map", "0:v:0", "-map", segment.hasAudio ? "0:a:0" : "1:a:0",
    "-c:v", "libx264", "-preset", encoding.preset, "-crf", String(encoding.crf),
    "-c:a", "aac", "-b:a", encoding.audioBitrate, "-ac", "2",
    "-t", segment.duration.toFixed(3), outputPath
  );
  await run(FFMPEG, args, { signal });
}

function effectFilters(effectOrSegment, base, width, height, duration) {
  const segment = typeof effectOrSegment === "string"
    ? { effect: effectOrSegment, sourceStart: 0, impactTime: 0.18, speed: 1 }
    : effectOrSegment;
  const effect = segment.effect;
  const speed = `setpts=PTS/${Math.max(segment.speed || 1, 0.01)}`;
  const detectedImpact = (segment.impactTime - segment.sourceStart) / Math.max(segment.speed || 1, 0.01);
  const impact = clamp(detectedImpact - 0.42, 0.08, Math.max(0.09, duration - 0.08));
  const hitStart = Math.max(0, impact - 0.055).toFixed(3);
  const hitEnd = Math.min(duration, impact + 0.16).toFixed(3);
  const preStart = Math.max(0, impact - 0.62).toFixed(3);
  const dipTime = Math.max(0.02, impact - 0.13).toFixed(3);
  const recoverTime = Math.max(0.04, impact).toFixed(3);
  const grade = segment.editingStyle === "aggressive"
    ? "hqdn3d=0.55:0.55:2.2:2.2,unsharp=5:5:1.35:3:3:0.35,eq=saturation=0.88:contrast=1.09:gamma=0.97,vignette=PI/6.2"
    : segment.editingStyle === "cinematic"
      ? "hqdn3d=0.9:0.9:3.2:3.2,unsharp=5:5:0.85:3:3:0.2,eq=saturation=0.66:contrast=1.04:gamma=1.01,vignette=PI/5.1"
      : "hqdn3d=0.7:0.7:2.8:2.8,unsharp=5:5:1.15:3:3:0.3,eq=saturation=0.74:contrast=1.055:gamma=0.98,vignette=PI/5.7";
  const fadeDown = Math.max(0.02, Number(dipTime) - Number(preStart)).toFixed(3);
  const fadeUp = Math.max(0.02, Number(recoverTime) - Number(dipTime)).toFixed(3);
  const preKillFade = `eq=brightness='if(between(t,${preStart},${dipTime}),-0.21*(t-${preStart})/${fadeDown},if(between(t,${dipTime},${recoverTime}),-0.21*(${recoverTime}-t)/${fadeUp},0))':saturation='if(between(t,${preStart},${dipTime}),1-0.92*(t-${preStart})/${fadeDown},if(between(t,${dipTime},${recoverTime}),1-0.92*(${recoverTime}-t)/${fadeUp},1))':eval=frame`;
  const impactStack = `${preKillFade},scale=${width + 32}:${height + 18},crop=${width}:${height}:x='(in_w-out_w)/2+if(between(t,${hitStart},${hitEnd}),7*sin(92*t),0)':y='(in_h-out_h)/2+if(between(t,${hitStart},${hitEnd}),5*cos(79*t),0)',rgbashift=rh=5:bh=-5:edge=wrap:enable='between(t,${hitStart},${hitEnd})',gblur=sigma=1.15:enable='between(t,${hitStart},${impact.toFixed(3)})',eq=brightness=0.3:enable='between(t,${impact.toFixed(3)},${Math.min(duration, impact + 0.075).toFixed(3)})'`;
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

async function concatenate(plan, outputPath, audioPath, audioOffset, duration, workingDirectory, signal = null, audioMix = { sourceVolume: 0.72, musicVolume: 0.82 }) {
  const concatPath = path.join(workingDirectory, "segments.txt");
  const lines = plan.map((segment) => `file '${segment.renderedPath.replaceAll("'", "'\\''").replaceAll("\\", "/")}'`);
  await fs.writeFile(concatPath, `${lines.join("\n")}\n`, "utf8");
  await run(FFMPEG, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "concat", "-safe", "0", "-i", concatPath,
    "-ss", Math.max(0, audioOffset).toFixed(3), "-i", audioPath,
    "-filter_complex", `[0:a:0]volume=${audioMix.sourceVolume.toFixed(3)}[source];[1:a:0]volume=${audioMix.musicVolume.toFixed(3)}[music];[source][music]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95,afade=t=out:st=${Math.max(0, duration - 0.35).toFixed(3)}:d=0.35[mix]`,
    "-map", "0:v:0", "-map", "[mix]",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "256k",
    "-t", duration.toFixed(3), "-movflags", "+faststart", outputPath
  ], { signal });
}

async function decoratePreview(inputPath, outputPath, { captionsPath, overlayPath, overlayPosition = "top-right", fontPath, width, encoding = encodingProfile(), signal = null }) {
  const filterPath = captionsPath?.replaceAll("\\", "/").replace(":", "\\:").replaceAll("'", "\\'");
  const appRoot = path.resolve(__dirname, "..", "..");
  const unpackedRoot = appRoot.includes("app.asar") ? appRoot.replace("app.asar", "app.asar.unpacked") : appRoot;
  const rawFontsPath = fontPath ? path.dirname(fontPath) : path.join(unpackedRoot, "assets", "fonts");
  const fontsPath = rawFontsPath.replaceAll("\\", "/").replace(":", "\\:").replaceAll("'", "\\'");
  const args = [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", inputPath
  ];
  if (overlayPath) args.push("-loop", "1", "-i", overlayPath);
  const videoFilters = [];
  const captionLabel = captionsPath ? "captioned" : "base";
  if (captionsPath) videoFilters.push(`[0:v]ass='${filterPath}':fontsdir='${fontsPath}'[captioned]`);
  else videoFilters.push("[0:v]null[base]");
  let outputLabel = captionLabel;
  if (overlayPath) {
    const size = Math.max(96, Math.round(width * 0.18));
    const positions = {
      "top-left": "24:24", "top-right": "W-w-24:24",
      "bottom-left": "24:H-h-24", "bottom-right": "W-w-24:H-h-24"
    };
    videoFilters.push(`[1:v]scale=${size}:-1:force_original_aspect_ratio=decrease[asset]`);
    videoFilters.push(`[${captionLabel}][asset]overlay=${positions[overlayPosition] || positions["top-right"]}:format=auto[outv]`);
    outputLabel = "outv";
  }
  args.push(
    "-filter_complex", videoFilters.join(";"),
    "-map", `[${outputLabel}]`, "-map", "0:a:0?",
    "-c:v", "libx264", "-preset", encoding.preset, "-crf", String(encoding.crf),
    "-c:a", "copy", "-shortest", "-movflags", "+faststart", outputPath
  );
  await run(FFMPEG, args, { signal });
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    const error = new Error("Render cancelled.");
    error.name = "AbortError";
    throw error;
  }
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
    averageHitSyncError: plan.length
      ? plan.reduce((sum, item) => sum + (item.hitSyncError || 0), 0) / plan.length
      : 0,
    doubleTapMoments: plan.filter((item) => item.keyMomentType === "double-tap").length,
    reference: { duration: reference.duration, width: reference.width, height: reference.height }
  };
}

module.exports = { assertToolchain, inspectProject, renderProject, effectFilters, montageDuration, outputProfile, encodingProfile };
