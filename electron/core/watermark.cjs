// Locates a static watermark (e.g. the Medal logo + username) in one of the
// frame corners. Gameplay footage moves constantly, so edges that stay in the
// same place across frames sampled from the whole clip belong to an overlay.
// The result is used for a delogo filter instead of cropping away the borders.

const { run, FFMPEG } = require("./media.cjs");

const SAMPLE_WIDTH = 320;
const SAMPLE_FRAMES = 24;
const EDGE_THRESHOLD = 14;
const PERSISTENCE = 0.8;

async function detectWatermark(filePath, info) {
  if (!info?.width || !info?.height || !(info.duration > 0.5)) return null;
  const width = SAMPLE_WIDTH;
  const height = Math.max(2, Math.round((info.height / info.width) * width / 2) * 2);
  const rate = Math.max(0.05, SAMPLE_FRAMES / info.duration);
  const { stdout } = await run(FFMPEG, [
    "-hide_banner", "-loglevel", "error", "-i", filePath,
    "-vf", `fps=${rate.toFixed(4)},scale=${width}:${height}:flags=area,format=gray`,
    "-frames:v", String(SAMPLE_FRAMES), "-an", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"
  ]);
  const box = findStaticOverlay(stdout, width, height);
  if (!box) return null;
  const scaleX = info.width / width;
  const scaleY = info.height / height;
  return clampBox({
    x: Math.floor(box.x * scaleX),
    y: Math.floor(box.y * scaleY),
    w: Math.ceil(box.w * scaleX),
    h: Math.ceil(box.h * scaleY),
    corner: box.corner,
    confidence: box.confidence
  }, info.width, info.height);
}

function findStaticOverlay(frames, width, height) {
  const size = width * height;
  const count = Math.floor(frames.length / size);
  if (count < 6) return null;
  const persistent = new Uint8Array(size);
  for (let frame = 0; frame < count; frame += 1) {
    const offset = frame * size;
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const index = y * width + x;
        const gradient = Math.abs(frames[offset + index + 1] - frames[offset + index - 1])
          + Math.abs(frames[offset + index + width] - frames[offset + index - width]);
        if (gradient > EDGE_THRESHOLD) persistent[index] += 1;
      }
    }
  }
  const needed = Math.ceil(count * PERSISTENCE);
  const mask = new Uint8Array(size);
  let total = 0;
  for (let index = 0; index < size; index += 1) {
    if (persistent[index] >= needed) { mask[index] = 1; total += 1; }
  }
  // A mostly static scene (menu, paused game) makes every edge persistent.
  if (total > size * 0.12) return null;
  const dilated = dilate(mask, width, height, 3);
  const corners = [
    { name: "top-left", x0: 0, x1: 0.3, y0: 0, y1: 0.24 },
    { name: "top-right", x0: 0.7, x1: 1, y0: 0, y1: 0.24 },
    { name: "bottom-left", x0: 0, x1: 0.3, y0: 0.76, y1: 1 },
    { name: "bottom-right", x0: 0.7, x1: 1, y0: 0.76, y1: 1 }
  ];
  let best = null;
  for (const corner of corners) {
    const region = {
      x0: Math.floor(corner.x0 * width), x1: Math.ceil(corner.x1 * width),
      y0: Math.floor(corner.y0 * height), y1: Math.ceil(corner.y1 * height)
    };
    const component = largestComponent(dilated, mask, width, region);
    if (!component) continue;
    const area = (region.x1 - region.x0) * (region.y1 - region.y0);
    if (component.edgePixels < size * 0.0012 || component.w * component.h > area * 0.7) continue;
    if (!best || component.edgePixels > best.edgePixels) best = { ...component, corner: corner.name };
  }
  if (!best) return null;
  const pad = 4;
  return {
    x: Math.max(0, best.x - pad),
    y: Math.max(0, best.y - pad),
    w: Math.min(width, best.x + best.w + pad) - Math.max(0, best.x - pad),
    h: Math.min(height, best.y + best.h + pad) - Math.max(0, best.y - pad),
    corner: best.corner,
    confidence: Math.min(1, best.edgePixels / (size * 0.006))
  };
}

function dilate(mask, width, height, radius) {
  const horizontal = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) continue;
      for (let dx = -radius; dx <= radius; dx += 1) {
        const nx = x + dx;
        if (nx >= 0 && nx < width) horizontal[y * width + nx] = 1;
      }
    }
  }
  const output = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!horizontal[y * width + x]) continue;
      for (let dy = -radius; dy <= radius; dy += 1) {
        const ny = y + dy;
        if (ny >= 0 && ny < height) output[ny * width + x] = 1;
      }
    }
  }
  return output;
}

function largestComponent(dilated, mask, width, region) {
  const seen = new Uint8Array(dilated.length);
  let best = null;
  for (let y = region.y0; y < region.y1; y += 1) {
    for (let x = region.x0; x < region.x1; x += 1) {
      const start = y * width + x;
      if (!dilated[start] || seen[start]) continue;
      const stack = [start];
      seen[start] = 1;
      let minX = x; let maxX = x; let minY = y; let maxY = y; let edgePixels = 0;
      while (stack.length) {
        const index = stack.pop();
        const cx = index % width;
        const cy = (index - cx) / width;
        if (mask[index]) edgePixels += 1;
        if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
        for (const next of [index - 1, index + 1, index - width, index + width]) {
          const nx = next % width;
          const ny = (next - nx) / width;
          if (nx < region.x0 || nx >= region.x1 || ny < region.y0 || ny >= region.y1) continue;
          if (Math.abs(nx - cx) > 1) continue;
          if (dilated[next] && !seen[next]) { seen[next] = 1; stack.push(next); }
        }
      }
      if (!best || edgePixels > best.edgePixels) {
        best = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, edgePixels };
      }
    }
  }
  return best;
}

// delogo needs a one-pixel border of real image around the box.
function clampBox(box, width, height) {
  const x = Math.max(1, Math.min(box.x, width - 3));
  const y = Math.max(1, Math.min(box.y, height - 3));
  const w = Math.max(2, Math.min(box.w, width - 1 - x));
  const h = Math.max(2, Math.min(box.h, height - 1 - y));
  return { ...box, x, y, w, h };
}

function delogoFilter(box) {
  return `delogo=x=${box.x}:y=${box.y}:w=${box.w}:h=${box.h}:show=0,`;
}

module.exports = { detectWatermark, findStaticOverlay, delogoFilter, clampBox };
