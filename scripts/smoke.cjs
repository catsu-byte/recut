const fs = require("node:fs/promises");
const path = require("node:path");
const { run, FFMPEG } = require("../electron/core/media.cjs");
const { inspectProject, renderProject } = require("../electron/core/pipeline.cjs");

const root = path.join(__dirname, "..", ".test-media");
const output = path.join(root, "output");

async function createVideo(filePath, source, frequency) {
  const args = [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", source
  ];
  if (frequency) args.push("-f", "lavfi", "-i", `sine=frequency=${frequency}:sample_rate=48000:duration=18`);
  args.push("-t", "18", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p");
  if (frequency) args.push("-c:a", "aac", "-shortest");
  args.push(filePath);
  await run(FFMPEG, args);
}

async function main() {
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(output, { recursive: true });
  const reference = path.join(root, "reference.mp4");
  const clipA = path.join(root, "clip-a.mp4");
  const clipB = path.join(root, "clip-b.mp4");
  const clipC = path.join(root, "clip-c.mp4");
  const overlay = path.join(root, "overlay.png");
  await Promise.all([
    createVideo(reference, "testsrc2=size=640x360:rate=30,eq=brightness='0.2*sin(2*PI*t)'", 440),
    createVideo(clipA, "testsrc2=size=640x360:rate=30", 320),
    createVideo(clipB, "smptebars=size=640x360:rate=30,rotate='0.02*sin(2*PI*t)'", 520),
    createVideo(clipC, "mandelbrot=size=640x360:rate=30", null)
  ]);
  await run(FFMPEG, [
    "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
    "-i", "color=c=0xC8FF24@0.75:s=160x80", "-frames:v", "1", overlay
  ]);
  const input = {
    referencePath: reference,
    musicPath: "",
    clipPaths: [clipA, clipB, clipC],
    medalClipPaths: [clipA],
    removeMedalWatermark: true,
    overlayPath: overlay,
    overlayPosition: "bottom-right",
    instructions: "Sync impacts exactly to the beat",
    editingStyle: "aggressive",
    renderQuality: "draft",
    outputDirectory: output,
    duration: 15,
    aspectRatio: "16:9"
  };
  const inspection = await inspectProject(input);
  if (inspection.clipInsights.length !== 3 || !inspection.clipInsights.every((clip) => clip.thumbnail?.startsWith("data:image/jpeg"))) {
    throw new Error("Review analysis did not create all expected clip thumbnails.");
  }
  input.analysisId = inspection.analysisId;
  input.impactOverrides = { [clipA]: Math.min(5, inspection.clipInsights[0].duration - 0.1) };
  const result = await renderProject(input, ({ percent, message }) => process.stdout.write(`${percent}% ${message}\n`));
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
