const fs = require("node:fs/promises");
const path = require("node:path");
const { run, FFMPEG } = require("../electron/core/media.cjs");
const { renderProject } = require("../electron/core/pipeline.cjs");

const root = path.join(__dirname, "..", ".test-media");
const output = path.join(root, "output");

async function createVideo(filePath, source, frequency) {
  await run(FFMPEG, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", source,
    "-f", "lavfi", "-i", `sine=frequency=${frequency}:sample_rate=48000:duration=18`,
    "-t", "18", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-shortest", filePath
  ]);
}

async function main() {
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(output, { recursive: true });
  const reference = path.join(root, "reference.mp4");
  const clipA = path.join(root, "clip-a.mp4");
  const clipB = path.join(root, "clip-b.mp4");
  const clipC = path.join(root, "clip-c.mp4");
  await Promise.all([
    createVideo(reference, "testsrc2=size=640x360:rate=30,eq=brightness='0.2*sin(2*PI*t)'", 440),
    createVideo(clipA, "testsrc2=size=640x360:rate=30", 320),
    createVideo(clipB, "smptebars=size=640x360:rate=30,rotate='0.02*sin(2*PI*t)'", 520),
    createVideo(clipC, "mandelbrot=size=640x360:rate=30", 720)
  ]);
  const result = await renderProject({
    referencePath: reference,
    musicPath: "",
    clipPaths: [clipA, clipB, clipC],
    outputDirectory: output,
    duration: 15,
    aspectRatio: "16:9"
  }, ({ percent, message }) => process.stdout.write(`${percent}% ${message}\n`));
  const files = await Promise.all([result.previewPath, result.timelinePath, result.reportPath].map(async (filePath) => ({
    filePath,
    size: (await fs.stat(filePath)).size
  })));
  if (files.some((file) => file.size === 0)) throw new Error("Smoke output contains an empty file.");
  process.stdout.write(`${JSON.stringify({ ...result, files }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
