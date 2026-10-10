const { spawn } = require("node:child_process");
const fs = require("node:fs");
const bundledFfmpeg = require("ffmpeg-static");
const bundledFfprobe = require("ffprobe-static").path;

function unpackedPath(binaryPath) {
  if (!binaryPath) return null;
  return binaryPath.includes("app.asar") ? binaryPath.replace("app.asar", "app.asar.unpacked") : binaryPath;
}

const FFMPEG = unpackedPath(bundledFfmpeg) || "ffmpeg";
const FFPROBE = unpackedPath(bundledFfprobe) || "ffprobe";

function run(binary, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true, ...options });
    const stdout = [];
    const stderr = [];
    child.stdout?.on("data", (chunk) => stdout.push(chunk));
    child.stderr?.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const out = Buffer.concat(stdout);
      const err = Buffer.concat(stderr).toString("utf8");
      if (code === 0) resolve({ stdout: out, stderr: err });
      else reject(new Error(`${binary} exited with code ${code}: ${err.slice(-2000)}`));
    });
  });
}

async function probe(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  const { stdout } = await run(FFPROBE, [
    "-v", "error",
    "-show_entries", "format=duration:stream=index,codec_type,width,height,r_frame_rate,sample_rate",
    "-of", "json",
    filePath
  ]);
  const data = JSON.parse(stdout.toString("utf8"));
  const video = data.streams?.find((stream) => stream.codec_type === "video");
  return {
    path: filePath,
    duration: Number(data.format?.duration || 0),
    width: Number(video?.width || 0),
    height: Number(video?.height || 0),
    fps: parseRate(video?.r_frame_rate)
  };
}

function parseRate(value = "0/1") {
  const [top, bottom] = value.split("/").map(Number);
  return bottom ? top / bottom : top || 0;
}

async function sceneCuts(filePath, duration, threshold = 0.29) {
  const { stderr } = await run(FFMPEG, [
    "-hide_banner", "-nostats", "-i", filePath,
    "-t", String(duration),
    "-vf", `select=gt(scene\\,${threshold}),showinfo`,
    "-an", "-f", "null", "-"
  ]);
  return [...stderr.matchAll(/pts_time:([0-9.]+)/g)]
    .map((match) => Number(match[1]))
    .filter((time) => time > 0.12 && time < duration - 0.12);
}

async function audioOnsets(filePath, duration) {
  const rate = 12000;
  const { stdout } = await run(FFMPEG, [
    "-hide_banner", "-loglevel", "error", "-i", filePath,
    "-t", String(duration), "-vn", "-ac", "1", "-ar", String(rate),
    "-f", "f32le", "pipe:1"
  ]);
  const samples = new Float32Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.byteLength / 4));
  const hop = 600;
  const energies = [];
  for (let offset = 0; offset + hop <= samples.length; offset += hop) {
    let total = 0;
    for (let i = offset; i < offset + hop; i += 1) total += samples[i] * samples[i];
    energies.push(Math.sqrt(total / hop));
  }
  const flux = energies.map((energy, index) => {
    const start = Math.max(0, index - 8);
    const window = energies.slice(start, index || 1);
    const baseline = window.reduce((sum, value) => sum + value, 0) / Math.max(1, window.length);
    return Math.max(0, energy - baseline);
  });
  const sorted = [...flux].sort((a, b) => a - b);
  const threshold = sorted[Math.floor(sorted.length * 0.78)] || 0;
  const peaks = [];
  for (let i = 2; i < flux.length - 2; i += 1) {
    if (flux[i] < threshold || flux[i] <= flux[i - 1] || flux[i] < flux[i + 1]) continue;
    const time = (i * hop) / rate;
    if (!peaks.length || time - peaks.at(-1).time >= 0.22) peaks.push({ time, strength: flux[i] });
  }
  const maximum = Math.max(...peaks.map((peak) => peak.strength), 0.00001);
  return peaks.map((peak) => ({ ...peak, strength: peak.strength / maximum }));
}

async function motionWindows(filePath, duration) {
  const width = 64;
  const height = 36;
  const fps = 4;
  const scanDuration = Math.min(duration, 180);
  const { stdout } = await run(FFMPEG, [
    "-hide_banner", "-loglevel", "error", "-i", filePath,
    "-t", String(scanDuration), "-vf", `fps=${fps},scale=${width}:${height},format=gray`,
    "-an", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"
  ]);
  const frameSize = width * height;
  const count = Math.floor(stdout.length / frameSize);
  const scores = [];
  for (let frame = 1; frame < count; frame += 1) {
    let difference = 0;
    const current = frame * frameSize;
    const previous = current - frameSize;
    for (let pixel = 0; pixel < frameSize; pixel += 4) {
      difference += Math.abs(stdout[current + pixel] - stdout[previous + pixel]);
    }
    scores.push({ time: frame / fps, score: difference / (frameSize / 4) / 255 });
  }
  const candidates = [...scores].sort((a, b) => b.score - a.score);
  const selected = [];
  for (const candidate of candidates) {
    if (candidate.time < 0.25 || candidate.time > duration - 0.5) continue;
    if (selected.every((item) => Math.abs(item.time - candidate.time) >= 2.5)) selected.push(candidate);
    if (selected.length >= 8) break;
  }
  if (!selected.length) selected.push({ time: Math.max(0, duration / 2), score: 0 });
  return selected;
}

module.exports = { run, probe, sceneCuts, audioOnsets, motionWindows, FFMPEG, FFPROBE };
