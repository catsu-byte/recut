const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");
const { Readable, Transform } = require("node:stream");
const { run } = require("./media.cjs");

const PAGE_HOSTS = new Set(["medal.tv", "www.medal.tv"]);
const MEDIA_HOST_PATTERN = /(^|\.)(medal\.tv|medalcdn\.com|medal\.gg)$/i;
const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const USER_AGENT = "Mozilla/5.0 (compatible; ReCut/0.8; +local video editor)";

function validateMedalUrl(value) {
  let text = String(value || "").trim();
  if (/^(www\.)?medal\.tv\//i.test(text)) text = `https://${text}`;
  let url;
  try { url = new URL(text); } catch { throw new Error("Enter a valid Medal.tv clip URL."); }
  if (url.protocol === "http:" && PAGE_HOSTS.has(url.hostname.toLowerCase())) url.protocol = "https:";
  if (url.protocol !== "https:" || !PAGE_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error("Only public HTTPS links on medal.tv are supported.");
  }
  if (!/\/clips?\//i.test(url.pathname) && !url.searchParams.get("contentId")) {
    throw new Error("The Medal.tv URL does not look like a clip link.");
  }
  url.hash = "";
  return url;
}

function medalClipId(url) {
  const fromQuery = url.searchParams.get("contentId");
  if (fromQuery) return fromQuery.replace(/[^a-z0-9_-]/gi, "");
  const parts = url.pathname.split("/").filter(Boolean);
  const index = parts.findIndex((part) => /^clips?$/i.test(part));
  return (parts[index + 1] || parts.at(-1) || "").replace(/[^a-z0-9_-]/gi, "");
}

// Collects every downloadable MP4/WebM the page exposes and prefers the
// highest resolution.
function extractMedalMediaUrl(html) {
  const source = String(html || "").replaceAll("\\/", "/").replaceAll("\\u002F", "/");
  const candidates = [
    ...source.matchAll(/<meta[^>]+(?:property|name)=["'](?:og:video(?::secure_url|:url)?|twitter:player:stream)["'][^>]+content=["']([^"']+)["']/gi),
    ...source.matchAll(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:video(?::secure_url|:url)?|twitter:player:stream)["']/gi),
    ...source.matchAll(/["'](?:contentUrl\w*|videoUrl\w*|video_url\w*|sourceUrl\w*)["']\s*:\s*["'](https:\/\/[^"']+)["']/gi),
    ...source.matchAll(/(https:\/\/[a-z0-9.-]+\/[^"'\s<>]+?\.(?:mp4|webm)(?:\?[^"'\s<>]*)?)/gi)
  ].map((match) => decodeHtml(match[1]));
  const valid = [];
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate);
      if (url.protocol === "https:" && MEDIA_HOST_PATTERN.test(url.hostname) && /\.(mp4|webm)(?:$|\?)/i.test(url.href)) valid.push(url);
    } catch { /* ignore malformed page metadata */ }
  }
  if (!valid.length) {
    throw new Error("No downloadable video was exposed by this Medal page. The clip may be private or Medal may have changed its page format.");
  }
  const quality = (url) => {
    const match = url.href.match(/(2160|1440|1080|720|480|360)p?/);
    return match ? Number(match[1]) : 600;
  };
  return valid.sort((a, b) => quality(b) - quality(a))[0];
}

async function importMedalClip(value, destinationDirectory) {
  const pageUrl = validateMedalUrl(value);
  await fsp.mkdir(destinationDirectory, { recursive: true });
  const clipId = medalClipId(pageUrl) || String(Date.now());
  const cached = await findCachedImport(destinationDirectory, clipId);
  if (cached) return { path: cached, sourceUrl: pageUrl.href, fromMedal: true, cached: true };
  const outputPath = path.join(destinationDirectory, `medal-${clipId}-${Date.now()}.mp4`);
  try {
    const mediaUrl = await resolveFromPage(pageUrl);
    await download(mediaUrl, pageUrl, outputPath);
    return { path: outputPath, sourceUrl: pageUrl.href, mediaUrl: mediaUrl.href, fromMedal: true };
  } catch (pageError) {
    await fsp.rm(outputPath, { force: true });
    // yt-dlp keeps up with Medal page changes; use it when it is installed.
    const viaYtDlp = await downloadWithYtDlp(pageUrl, outputPath).catch(() => null);
    if (viaYtDlp) return { path: viaYtDlp, sourceUrl: pageUrl.href, fromMedal: true, via: "yt-dlp" };
    throw pageError;
  }
}

// Several links at once (one per line, or separated by spaces/commas).
async function importMedalClips(text, destinationDirectory, onProgress = () => {}) {
  const links = [...new Set(String(text || "").split(/[\s,;]+/).map((item) => item.trim()).filter(Boolean))];
  if (!links.length) throw new Error("Paste at least one Medal.tv clip link.");
  const imported = [];
  const failed = [];
  for (let index = 0; index < links.length; index += 1) {
    onProgress({ index, total: links.length, link: links[index] });
    try {
      imported.push(await importMedalClip(links[index], destinationDirectory));
    } catch (error) {
      failed.push({ link: links[index], error: error.message });
    }
  }
  return { imported, failed };
}

async function resolveFromPage(pageUrl) {
  const pageResponse = await fetch(pageUrl, {
    redirect: "follow",
    headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml", "accept-language": "en-US,en;q=0.8" }
  });
  const finalPageUrl = new URL(pageResponse.url);
  if (!PAGE_HOSTS.has(finalPageUrl.hostname.toLowerCase())) throw new Error("Medal redirected the clip page to an unsupported host.");
  if (!pageResponse.ok) throw new Error(`Medal returned HTTP ${pageResponse.status} for this clip.`);
  return extractMedalMediaUrl(await pageResponse.text());
}

async function download(mediaUrl, pageUrl, outputPath) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const mediaResponse = await fetch(mediaUrl, { redirect: "follow", headers: { referer: pageUrl.href, "user-agent": USER_AGENT } });
      const finalMediaUrl = new URL(mediaResponse.url);
      if (!MEDIA_HOST_PATTERN.test(finalMediaUrl.hostname)) throw new Error("Medal redirected the video to an unsupported media host.");
      if (!mediaResponse.ok || !mediaResponse.body) throw new Error(`The Medal video download failed with HTTP ${mediaResponse.status}.`);
      const length = Number(mediaResponse.headers.get("content-length") || 0);
      if (length > MAX_DOWNLOAD_BYTES) throw new Error("The Medal clip is larger than the 2 GB safety limit.");
      await pipeline(Readable.fromWeb(mediaResponse.body), byteLimit(MAX_DOWNLOAD_BYTES), fs.createWriteStream(outputPath, { flags: "w" }));
      return;
    } catch (error) {
      lastError = error;
      if (/unsupported|safety limit|HTTP 4\d\d/.test(error.message)) break;
      await new Promise((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function downloadWithYtDlp(pageUrl, outputPath) {
  const binary = process.env.RECUT_YTDLP || "yt-dlp";
  await run(binary, [
    "--no-playlist", "--no-progress", "--max-filesize", "2G",
    "-f", "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b",
    "--merge-output-format", "mp4",
    "-o", outputPath, pageUrl.href
  ]);
  return fs.existsSync(outputPath) ? outputPath : null;
}

async function findCachedImport(directory, clipId) {
  if (!clipId) return null;
  try {
    const entries = await fsp.readdir(directory);
    const match = entries.filter((name) => name.startsWith(`medal-${clipId}-`) && name.endsWith(".mp4")).sort().at(-1);
    if (!match) return null;
    const filePath = path.join(directory, match);
    return (await fsp.stat(filePath)).size > 1024 ? filePath : null;
  } catch {
    return null;
  }
}

function byteLimit(maximum) {
  let total = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      total += chunk.length;
      callback(total > maximum ? new Error("The Medal clip exceeded the 2 GB safety limit.") : null, chunk);
    }
  });
}

function decodeHtml(value) {
  return String(value).replaceAll("&amp;", "&").replaceAll("&#x2F;", "/").replaceAll("&quot;", '"');
}

module.exports = { validateMedalUrl, extractMedalMediaUrl, importMedalClip, importMedalClips, medalClipId, MEDIA_HOST_PATTERN };
