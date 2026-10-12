const path = require("node:path");
const fs = require("node:fs/promises");
const { run, FFMPEG } = require("./media.cjs");
const { alignPlainLyrics } = require("./lyrics.cjs");

function scriptPath(name = "transcribe.py") {
  const appRoot = path.resolve(__dirname, "..", "..");
  const unpackedRoot = appRoot.includes("app.asar") ? appRoot.replace("app.asar", "app.asar.unpacked") : appRoot;
  return path.join(unpackedRoot, "scripts", name);
}

async function transcribeClips(clipPaths) {
  const python = process.env.RECUT_PYTHON || "python";
  const model = process.env.RECUT_WHISPER_MODEL || "base";
  try {
    const { stdout } = await run(python, [scriptPath(), "--model", model, ...clipPaths]);
    return { status: "ready", model, clips: JSON.parse(stdout.toString("utf8")) };
  } catch (error) {
    return {
      status: "unavailable",
      model,
      clips: [],
      error: `Automatic captions are unavailable: ${error.message}`
    };
  }
}

const MODEL_BY_QUALITY = Object.freeze({ fast: "small", accurate: "medium", best: "large-v3", auto: "auto" });
let vocalSeparation = null;

async function checkVocalSeparation() {
  if (vocalSeparation) return vocalSeparation;
  const python = process.env.RECUT_PYTHON || "python";
  vocalSeparation = run(python, ["-c", "import demucs; print(demucs.__version__)"])
    .then(() => true)
    .catch(() => false);
  return vocalSeparation;
}

async function transcribeMusicSection(audioPath, offset, duration, workingDirectory, options = {}) {
  // Transcribe a few seconds of context around the section: Whisper misses or
  // garbles words that are cut in half at the section boundaries.
  const lead = Math.min(3, Math.max(0, offset));
  const extractedPath = path.join(workingDirectory, "music-section.wav");
  const separate = options.separateVocals !== false && await checkVocalSeparation();
  await run(FFMPEG, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-ss", Math.max(0, offset - lead).toFixed(3), "-i", audioPath,
    "-t", (duration + lead + 2).toFixed(3), "-vn",
    // Demucs wants the untouched stereo mix; without it, a vocal-band filter
    // takes some of the bass and hi-hats out of Whisper's way.
    ...(separate
      ? ["-ac", "2", "-ar", "44100"]
      : ["-af", "highpass=f=120,lowpass=f=7600,dynaudnorm=f=200:g=11", "-ac", "1", "-ar", "16000"]),
    "-c:a", "pcm_s16le", extractedPath
  ]);
  const python = process.env.RECUT_PYTHON || "python";
  const model = process.env.RECUT_WHISPER_MODEL || MODEL_BY_QUALITY[options.quality] || "auto";
  const language = (options.language || process.env.RECUT_LYRIC_LANGUAGE || "").trim();
  const plainLyrics = String(options.plainLyrics || "").trim();
  try {
    const args = [scriptPath(), "--model", model, "--song", "--offset", lead.toFixed(3), "--clip-end", duration.toFixed(3)];
    if (separate) args.push("--vocals");
    if (language) args.push("--language", language);
    if (plainLyrics) {
      const promptPath = path.join(workingDirectory, "lyrics-hint.txt");
      await fs.writeFile(promptPath, plainLyrics, "utf8");
      args.push("--prompt-file", promptPath);
    }
    args.push(extractedPath);
    const { stdout } = await run(python, args);
    const [result] = JSON.parse(stdout.toString("utf8"));
    const transcript = clipTranscript(result, duration);
    if (plainLyrics) {
      return {
        status: "aligned", model: result.model || model, sectionPath: extractedPath,
        vocalsSeparated: Boolean(result.vocalsSeparated), transcript: alignPlainLyrics(transcript, plainLyrics)
      };
    }
    return { status: "ready", model: result.model || model, sectionPath: extractedPath, vocalsSeparated: Boolean(result.vocalsSeparated), transcript };
  } catch (error) {
    return {
      status: "unavailable", model, sectionPath: extractedPath, transcript: null,
      error: `Automatic lyric captions are unavailable: ${error.message}`
    };
  }
}

function clipTranscript(transcript, duration) {
  const segments = (transcript?.segments || []).map((segment) => ({
    ...segment,
    words: (segment.words || [])
      .filter((word) => word.end > 0.02 && word.start < duration - 0.02)
      .map((word) => ({ ...word, start: Math.max(0, word.start), end: Math.min(duration, word.end) }))
  })).filter((segment) => segment.words.length);
  return { ...transcript, segments };
}

async function matchMusicSection(referencePath, musicPath, duration) {
  const python = process.env.RECUT_PYTHON || "python";
  try {
    const { stdout } = await run(python, [
      scriptPath("match_audio.py"), referencePath, musicPath,
      duration.toFixed(3), FFMPEG
    ]);
    const result = JSON.parse(stdout.toString("utf8"));
    return { offset: result.offset, confidence: result.confidence, method: "spectral" };
  } catch (error) {
    return { offset: null, confidence: 0, method: "spectral-unavailable", error: error.message };
  }
}

async function checkTranscriptionEngine() {
  const python = process.env.RECUT_PYTHON || "python";
  try {
    await run(python, ["-c", "import faster_whisper; print(faster_whisper.__version__)"]);
    return { available: true, python, vocalSeparation: await checkVocalSeparation() };
  } catch (error) {
    return { available: false, python, message: "Install faster-whisper to enable automatic lyric captions." };
  }
}

module.exports = { transcribeClips, transcribeMusicSection, clipTranscript, checkVocalSeparation, matchMusicSection, checkTranscriptionEngine, scriptPath };
