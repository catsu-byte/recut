const { spawn } = require("node:child_process");
const fs = require("node:fs");
const bundledFfmpeg = require("ffmpeg-static");
const bundledFfprobe = require("ffprobe-static").path;

function unpackedPath(binaryPath) {
  if (!binaryPath) return null;
  return binaryPath.includes("app.asar") ? binaryPath.replace("app.asar", "app.asar.unpacked") : binaryPath;
}

function availableBinary(bundledPath, fallback) {
  const candidate = unpackedPath(bundledPath);
  return candidate && fs.existsSync(candidate) ? candidate : fallback;
}

const FFMPEG = availableBinary(bundledFfmpeg, "ffmpeg");
const FFPROBE = availableBinary(bundledFfprobe, "ffprobe");

function run(binary, args, options = {}) {
  return new Promise((resolve, reject) => {
    const spawnOptions = { windowsHide: true, ...options };
    if (!spawnOptions.signal) delete spawnOptions.signal;
    const child = spawn(binary, args, spawnOptions);
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
    "-show_entries", "format=duration:stream=index,codec_type,width,height,r_frame_rate,sample_rate,duration",
    "-of", "json",
    filePath
  ]);
  const data = JSON.parse(stdout.toString("utf8"));
  const video = data.streams?.find((stream) => stream.codec_type === "video");
  const audio = data.streams?.find((stream) => stream.codec_type === "audio");
  let duration;
  try {
    duration = selectDuration(data, filePath);
  } catch {
    duration = await durationFromPackets(filePath);
  }
  return {
    path: filePath,
    duration,
    width: Number(video?.width || 0),
    height: Number(video?.height || 0),
    fps: parseRate(video?.r_frame_rate),
    hasAudio: Boolean(audio)
  };
}

async function durationFromPackets(filePath) {
  const { stdout } = await run(FFPROBE, [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "packet=pts_time,duration_time",
    "-of", "csv=p=0", filePath
  ]);
  const duration = parsePacketDuration(stdout.toString("utf8"));
  if (!Number.isFinite(duration) || duration <= 0.05) {
    throw new Error(`Could not read a valid duration from ${filePath}. Try remuxing the file to MP4 in DaVinci Resolve or FFmpeg.`);
  }
  return duration;
}

function parsePacketDuration(csv) {
  let maximum = 0;
  for (const line of String(csv).split(/\r?\n/)) {
    const values = line.split(",").map(Number).filter(Number.isFinite);
    if (!values.length) continue;
    const end = values[0] + Math.max(0, values[1] || 0);
    if (end > maximum) maximum = end;
  }
  return maximum;
}

function selectDuration(data, filePath = "media file") {
  const candidates = [
    data?.format?.duration,
    ...(data?.streams || []).map((stream) => stream.duration)
  ]
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0.05 && value < 86_400)
    .sort((a, b) => b - a);
  if (!candidates.length) {
    throw new Error(`Could not read a valid duration from ${filePath}. Try remuxing the file to MP4 in DaVinci Resolve or FFmpeg.`);
  }
  return candidates[0];
}

function parseRate(value = "0/1") {
  const [top, bottom] = value.split("/").map(Number);
  return bottom ? top / bottom : top || 0;
}

async function sceneCuts(filePath, duration, threshold = 0.29) {
  assertPositiveDuration(duration, filePath);
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

async function audioOnsets(filePath, duration, startTime = 0, options = {}) {
  assertPositiveDuration(duration, filePath);
  const rate = 12000;
  const args = [
    "-hide_banner", "-loglevel", "error", "-ss", String(Math.max(0, startTime)), "-i", filePath,
    "-t", String(duration), "-vn", "-ac", "1", "-ar", String(rate)
  ];
  // A high-pass view isolates crisp hit/kill sounds from explosions and music.
  if (options.highpass) args.push("-af", `highpass=f=${Math.round(options.highpass)},highpass=f=${Math.round(options.highpass)}`);
  args.push("-f", "f32le", "pipe:1");
  const { stdout } = await run(FFMPEG, args);
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

async function audioEnvelope(filePath, maximumDuration = null) {
  const rate = 4000;
  const args = ["-hide_banner", "-loglevel", "error", "-i", filePath];
  if (Number.isFinite(maximumDuration) && maximumDuration > 0) args.push("-t", String(maximumDuration));
  args.push("-vn", "-ac", "1", "-ar", String(rate), "-f", "f32le", "pipe:1");
  const { stdout } = await run(FFMPEG, args);
  const samples = new Float32Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.byteLength / 4));
  const hop = 200;
  const envelope = [];
  for (let offset = 0; offset + hop <= samples.length; offset += hop) {
    let total = 0;
    for (let index = offset; index < offset + hop; index += 1) total += samples[index] * samples[index];
    envelope.push(Math.log10(1e-7 + Math.sqrt(total / hop)));
  }
  return { values: envelope, samplesPerSecond: rate / hop };
}

async function findAudioOffset(referencePath, musicPath, referenceDuration) {
  const [reference, music] = await Promise.all([
    audioEnvelope(referencePath, referenceDuration),
    audioEnvelope(musicPath)
  ]);
  if (music.values.length <= reference.values.length + 2) return { offset: 0, confidence: 0 };
  const result = correlateEnvelopes(reference.values, music.values);
  return {
    offset: result.index / reference.samplesPerSecond,
    confidence: result.score
  };
}

function correlateEnvelopes(referenceValues, musicValues) {
  const reference = normalize(referenceValues);
  const length = reference.length;
  const prefix = [0];
  const prefixSquare = [0];
  for (const value of musicValues) {
    prefix.push(prefix.at(-1) + value);
    prefixSquare.push(prefixSquare.at(-1) + value * value);
  }
  let bestIndex = 0;
  let bestScore = -Infinity;
  for (let offset = 0; offset <= musicValues.length - length; offset += 1) {
    const sum = prefix[offset + length] - prefix[offset];
    const squareSum = prefixSquare[offset + length] - prefixSquare[offset];
    const mean = sum / length;
    const variance = Math.max(1e-9, squareSum / length - mean * mean);
    const deviation = Math.sqrt(variance);
    let dot = 0;
    for (let index = 0; index < length; index += 1) {
      dot += reference[index] * ((musicValues[offset + index] - mean) / deviation);
    }
    const score = dot / length;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = offset;
    }
  }
  return { index: bestIndex, score: bestScore };
}

function normalize(values) {
  const mean = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, values.length);
  const deviation = Math.sqrt(Math.max(variance, 1e-9));
  return values.map((value) => (value - mean) / deviation);
}

async function motionWindows(filePath, duration) {
  return (await motionProfile(filePath, duration)).candidates;
}

async function motionProfile(filePath, duration) {
  assertPositiveDuration(duration, filePath);
  const width = 64;
  const height = 36;
  const fps = 8;
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
  return { candidates: selected, curve: scores };
}

async function thumbnailDataUrl(filePath, time, width = 480) {
  const { stdout } = await run(FFMPEG, [
    "-hide_banner", "-loglevel", "error", "-ss", String(Math.max(0, Number(time) || 0)),
    "-i", filePath, "-frames:v", "1", "-vf", `scale=${Math.max(160, Math.min(960, width))}:-2:flags=lanczos`,
    "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1"
  ]);
  return `data:image/jpeg;base64,${stdout.toString("base64")}`;
}

function assertPositiveDuration(duration, filePath) {
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Invalid media duration for ${filePath}. Re-export or remux this file and try again.`);
  }
}

module.exports = {
  run, probe, sceneCuts, audioOnsets, audioEnvelope, findAudioOffset, correlateEnvelopes,
  motionWindows, motionProfile, thumbnailDataUrl, selectDuration, parsePacketDuration, FFMPEG, FFPROBE
};
