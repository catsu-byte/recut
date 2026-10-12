// Font helpers: read a font's real family name (so users never have to type
// it) and find the installed font that best matches a screenshot of text,
// e.g. a frame from a reference edit.

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { run, FFMPEG, FFPROBE } = require("./media.cjs");

const FONT_EXTENSIONS = new Set([".ttf", ".otf"]);
const ROW_HEIGHT = 170;
const CANVAS_WIDTH = 2600;
const FONTS_PER_PASS = 40;
const MATCH_HEIGHT = 40;

async function readFontFamily(filePath) {
  const handle = await fs.open(filePath, "r");
  try {
    const header = Buffer.alloc(12);
    await handle.read(header, 0, 12, 0);
    const tableCount = header.readUInt16BE(4);
    const directory = Buffer.alloc(tableCount * 16);
    await handle.read(directory, 0, directory.length, 12);
    let nameOffset = -1;
    let nameLength = 0;
    for (let index = 0; index < tableCount; index += 1) {
      if (directory.toString("latin1", index * 16, index * 16 + 4) === "name") {
        nameOffset = directory.readUInt32BE(index * 16 + 8);
        nameLength = directory.readUInt32BE(index * 16 + 12);
      }
    }
    if (nameOffset < 0) return null;
    const table = Buffer.alloc(Math.min(nameLength, 1024 * 1024));
    await handle.read(table, 0, table.length, nameOffset);
    return parseNameTable(table);
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

function parseNameTable(table) {
  const count = table.readUInt16BE(2);
  const storage = table.readUInt16BE(4);
  const names = {};
  for (let index = 0; index < count; index += 1) {
    const record = 6 + index * 12;
    if (record + 12 > table.length) break;
    const platform = table.readUInt16BE(record);
    const language = table.readUInt16BE(record + 4);
    const nameId = table.readUInt16BE(record + 6);
    const length = table.readUInt16BE(record + 8);
    const offset = storage + table.readUInt16BE(record + 10);
    if (![1, 2, 4, 16].includes(nameId) || offset + length > table.length) continue;
    let value = null;
    if (platform === 3 || platform === 0) {
      const bytes = Buffer.from(table.subarray(offset, offset + length));
      bytes.swap16();
      value = bytes.toString("utf16le");
    } else if (platform === 1) {
      value = table.toString("latin1", offset, offset + length);
    }
    if (!value) continue;
    // Prefer English Windows names, otherwise keep the first one found.
    const preferred = platform === 3 && language === 0x409;
    if (!names[nameId] || preferred) names[nameId] = value.replace(/\0/g, "").trim();
  }
  const family = names[16] || names[1];
  return family ? { family, subfamily: names[2] || "", fullName: names[4] || family } : null;
}

function fontDirectories(extra = []) {
  const home = os.homedir();
  const directories = [...extra];
  if (process.platform === "win32") {
    directories.push(path.join(process.env.WINDIR || "C:\\Windows", "Fonts"));
    if (process.env.LOCALAPPDATA) directories.push(path.join(process.env.LOCALAPPDATA, "Microsoft", "Windows", "Fonts"));
  } else if (process.platform === "darwin") {
    directories.push("/System/Library/Fonts", "/Library/Fonts", path.join(home, "Library", "Fonts"));
  } else {
    directories.push("/usr/share/fonts", "/usr/local/share/fonts", path.join(home, ".local", "share", "fonts"), path.join(home, ".fonts"));
  }
  return directories;
}

async function listFontFiles(directories, limit = 2500) {
  const found = [];
  async function walk(directory, depth) {
    if (found.length >= limit || depth > 4) return;
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(fullPath, depth + 1);
      else if (FONT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) found.push(fullPath);
      if (found.length >= limit) return;
    }
  }
  for (const directory of directories) await walk(directory, 0);
  return [...new Set(found)];
}

async function imageSize(filePath) {
  const { stdout } = await run(FFPROBE, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", filePath]);
  const stream = JSON.parse(stdout.toString("utf8")).streams?.[0];
  if (!stream?.width || !stream?.height) throw new Error("Could not read the image size.");
  return { width: stream.width, height: stream.height };
}

async function loadTextMask(imagePath, crop = null) {
  const size = await imageSize(imagePath);
  const scale = Math.min(1, 1000 / size.width);
  const width = Math.max(8, Math.round(size.width * scale / 2) * 2);
  const height = Math.max(8, Math.round(size.height * scale / 2) * 2);
  const filters = [];
  if (crop) filters.push(`crop=${Math.round(crop.w)}:${Math.round(crop.h)}:${Math.round(crop.x)}:${Math.round(crop.y)}`);
  const outWidth = crop ? Math.max(8, Math.round(crop.w * scale / 2) * 2) : width;
  const outHeight = crop ? Math.max(8, Math.round(crop.h * scale / 2) * 2) : height;
  filters.push(`scale=${outWidth}:${outHeight}:flags=area`, "format=gray");
  const { stdout } = await run(FFMPEG, ["-hide_banner", "-loglevel", "error", "-i", imagePath, "-frames:v", "1", "-vf", filters.join(","), "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"]);
  return textMaskFromGray(stdout, outWidth, outHeight);
}

// Otsu threshold; the text is assumed to be the minority colour.
function textMaskFromGray(gray, width, height) {
  const histogram = new Array(256).fill(0);
  for (let index = 0; index < width * height; index += 1) histogram[gray[index]] += 1;
  const total = width * height;
  let sum = 0;
  for (let value = 0; value < 256; value += 1) sum += value * histogram[value];
  let background = 0; let backgroundSum = 0; let best = 0; let threshold = 127;
  for (let value = 0; value < 256; value += 1) {
    background += histogram[value];
    if (!background || background === total) continue;
    backgroundSum += value * histogram[value];
    const meanLow = backgroundSum / background;
    const meanHigh = (sum - backgroundSum) / (total - background);
    const between = background * (total - background) * (meanLow - meanHigh) ** 2;
    if (between > best) { best = between; threshold = value; }
  }
  const mask = new Uint8Array(total);
  let bright = 0;
  for (let index = 0; index < total; index += 1) if (gray[index] > threshold) bright += 1;
  const textIsBright = bright < total / 2;
  for (let index = 0; index < total; index += 1) {
    mask[index] = (gray[index] > threshold) === textIsBright ? 1 : 0;
  }
  return { mask, width, height };
}

function cropToContent({ mask, width, height }) {
  const rows = new Array(height).fill(0);
  const cols = new Array(width).fill(0);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (mask[y * width + x]) { rows[y] += 1; cols[x] += 1; }
    }
  }
  const minimumRow = Math.max(1, Math.round(width * 0.002));
  const minimumCol = 1;
  const top = rows.findIndex((count) => count >= minimumRow);
  const bottom = height - 1 - [...rows].reverse().findIndex((count) => count >= minimumRow);
  const left = cols.findIndex((count) => count >= minimumCol);
  const right = width - 1 - [...cols].reverse().findIndex((count) => count >= minimumCol);
  if (top < 0 || left < 0 || bottom <= top || right <= left) return null;
  const w = right - left + 1;
  const h = bottom - top + 1;
  const output = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) output[y * w + x] = mask[(top + y) * width + left + x];
  }
  return { mask: output, width: w, height: h };
}

function resample(shape, width, height) {
  const output = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.floor((x / width) * shape.width);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) / width) * shape.width));
      const y0 = Math.floor((y / height) * shape.height);
      const y1 = Math.max(y0 + 1, Math.floor(((y + 1) / height) * shape.height));
      let total = 0;
      for (let sy = y0; sy < y1; sy += 1) for (let sx = x0; sx < x1; sx += 1) total += shape.mask[sy * shape.width + sx];
      output[y * width + x] = total / ((x1 - x0) * (y1 - y0));
    }
  }
  return output;
}

function shapeSimilarity(target, candidate) {
  const targetAspect = target.width / target.height;
  const candidateAspect = candidate.width / candidate.height;
  const height = MATCH_HEIGHT;
  const width = Math.max(8, Math.round(height * targetAspect));
  const a = resample(target, width, height);
  const b = resample(candidate, width, height);
  let product = 0; let sumA = 0; let sumB = 0;
  for (let index = 0; index < a.length; index += 1) {
    product += a[index] * b[index];
    sumA += a[index] * a[index];
    sumB += b[index] * b[index];
  }
  const cosine = product / Math.sqrt(Math.max(1e-9, sumA * sumB));
  const inkA = a.reduce((sum, value) => sum + value, 0) / a.length;
  const inkB = b.reduce((sum, value) => sum + value, 0) / b.length;
  // Same letters in a different font differ mostly in width and stroke weight.
  return cosine - 0.55 * Math.abs(Math.log(candidateAspect / targetAspect)) - 0.6 * Math.abs(inkA - inkB);
}

function escapeFilterPath(value) {
  return value.replaceAll("\\", "/").replaceAll(":", "\\:").replaceAll("'", "\\'");
}

function escapeDrawtext(value) {
  return value.replaceAll("\\", "\\\\").replaceAll(":", "\\:").replaceAll("'", "\u2019").replaceAll("%", "\\%");
}

async function renderCandidates(fonts, text) {
  const height = ROW_HEIGHT * fonts.length;
  const draws = fonts.map((fontPath, index) =>
    `drawtext=fontfile='${escapeFilterPath(fontPath)}':text='${escapeDrawtext(text)}':fontsize=110:fontcolor=white:x=20:y=${index * ROW_HEIGHT + 25}`
  );
  const { stdout } = await run(FFMPEG, [
    "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=black:s=${CANVAS_WIDTH}x${height}:d=1`,
    "-frames:v", "1", "-vf", `${draws.join(",")},format=gray`, "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"
  ]);
  return fonts.map((fontPath, index) => {
    const offset = index * ROW_HEIGHT * CANVAS_WIDTH;
    const row = stdout.subarray(offset, offset + ROW_HEIGHT * CANVAS_WIDTH);
    const mask = new Uint8Array(row.length);
    for (let pixel = 0; pixel < row.length; pixel += 1) mask[pixel] = row[pixel] > 110 ? 1 : 0;
    return { fontPath, shape: cropToContent({ mask, width: CANVAS_WIDTH, height: ROW_HEIGHT }) };
  });
}

async function matchFontFromImage(imagePath, text, { extraDirectories = [], crop = null, limit = 6, onProgress = () => {} } = {}) {
  const sample = String(text || "").trim();
  if (!sample) throw new Error("Type the exact text that is visible in the image.");
  if (sample.length > 40) throw new Error("Use a short text sample (up to 40 characters).");
  const target = cropToContent(await loadTextMask(imagePath, crop));
  if (!target) throw new Error("No text could be separated from the background. Crop the image closer to the text.");
  const fonts = await listFontFiles(fontDirectories(extraDirectories));
  if (!fonts.length) throw new Error("No installed TTF/OTF fonts were found.");
  const results = [];
  for (let start = 0; start < fonts.length; start += FONTS_PER_PASS) {
    const batch = fonts.slice(start, start + FONTS_PER_PASS);
    let rendered;
    try {
      rendered = await renderCandidates(batch, sample);
    } catch {
      // One broken font fails the whole pass; retry those fonts one by one.
      rendered = [];
      for (const fontPath of batch) {
        try { rendered.push(...await renderCandidates([fontPath], sample)); } catch { /* skip unreadable font */ }
      }
    }
    for (const item of rendered) {
      if (item.shape) results.push({ fontPath: item.fontPath, score: shapeSimilarity(target, item.shape) });
    }
    onProgress({ done: Math.min(fonts.length, start + FONTS_PER_PASS), total: fonts.length });
  }
  const best = results.sort((a, b) => b.score - a.score);
  const unique = [];
  const families = new Set();
  for (const item of best) {
    const info = await readFontFamily(item.fontPath);
    const family = info?.family || path.basename(item.fontPath, path.extname(item.fontPath));
    const key = `${family}|${info?.subfamily || ""}`;
    if (families.has(key)) continue;
    families.add(key);
    unique.push({ ...item, family, style: info?.subfamily || "", score: Math.round(item.score * 1000) / 1000 });
    if (unique.length >= limit) break;
  }
  return { candidates: unique, scanned: fonts.length };
}

module.exports = {
  readFontFamily, parseNameTable, fontDirectories, listFontFiles, matchFontFromImage,
  textMaskFromGray, cropToContent, shapeSimilarity
};
