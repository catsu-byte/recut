const path = require("node:path");
const { run, FFMPEG } = require("./media.cjs");

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

async function transcribeMusicSection(audioPath, offset, duration, workingDirectory) {
  const extractedPath = path.join(workingDirectory, "music-section.wav");
  await run(FFMPEG, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-ss", Math.max(0, offset).toFixed(3), "-i", audioPath,
    "-t", duration.toFixed(3), "-vn", "-ac", "1", "-ar", "16000",
    "-c:a", "pcm_s16le", extractedPath
  ]);
  const python = process.env.RECUT_PYTHON || "python";
  const model = process.env.RECUT_WHISPER_MODEL || "small.en";
  try {
    const { stdout } = await run(python, [scriptPath(), "--model", model, "--language", "en", "--song", extractedPath]);
    const [result] = JSON.parse(stdout.toString("utf8"));
    return { status: "ready", model, sectionPath: extractedPath, transcript: result };
  } catch (error) {
    return {
      status: "unavailable", model, sectionPath: extractedPath, transcript: null,
      error: `Automatic lyric captions are unavailable: ${error.message}`
    };
  }
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

module.exports = { transcribeClips, transcribeMusicSection, matchMusicSection, scriptPath };
