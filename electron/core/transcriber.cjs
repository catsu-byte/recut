const path = require("node:path");
const { run } = require("./media.cjs");

function scriptPath() {
  const appRoot = path.resolve(__dirname, "..", "..");
  const unpackedRoot = appRoot.includes("app.asar") ? appRoot.replace("app.asar", "app.asar.unpacked") : appRoot;
  return path.join(unpackedRoot, "scripts", "transcribe.py");
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

module.exports = { transcribeClips, scriptPath };
