const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");
const { Readable, Transform } = require("node:stream");

const PAGE_HOSTS = new Set(["medal.tv", "www.medal.tv"]);
const MEDIA_HOST_PATTERN = /(^|\.)(medal\.tv|medalcdn\.com|medal\.gg)$/i;
const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024;

function validateMedalUrl(value) {
  let url;
  try { url = new URL(String(value || "").trim()); } catch { throw new Error("Enter a valid Medal.tv clip URL."); }
  if (url.protocol !== "https:" || !PAGE_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error("Only public HTTPS links on medal.tv are supported.");
  }
  if (!/\/clips?\//i.test(url.pathname)) throw new Error("The Medal.tv URL does not look like a clip link.");
  url.hash = "";
  return url;
}

function extractMedalMediaUrl(html) {
  const source = String(html || "").replaceAll("\\/", "/");
  const candidates = [
    ...source.matchAll(/<meta[^>]+(?:property|name)=["'](?:og:video(?::secure_url)?|twitter:player:stream)["'][^>]+content=["']([^"']+)["']/gi),
    ...source.matchAll(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:video(?::secure_url)?|twitter:player:stream)["']/gi),
    ...source.matchAll(/["'](?:contentUrl|videoUrl|video_url)["']\s*:\s*["'](https:\/\/[^"']+)["']/gi)
  ].map((match) => decodeHtml(match[1]));
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate);
      if (url.protocol === "https:" && MEDIA_HOST_PATTERN.test(url.hostname) && /\.(mp4|webm)(?:$|\?)/i.test(url.href)) return url;
    } catch { /* ignore malformed page metadata */ }
  }
  throw new Error("No downloadable video was exposed by this Medal page. The clip may be private or Medal may have changed its page format.");
}

async function importMedalClip(value, destinationDirectory) {
  const pageUrl = validateMedalUrl(value);
  await fsp.mkdir(destinationDirectory, { recursive: true });
  const pageResponse = await fetch(pageUrl, { redirect: "follow", headers: { "user-agent": "ReCut/0.7 (+local editor)" } });
  const finalPageUrl = new URL(pageResponse.url);
  if (!PAGE_HOSTS.has(finalPageUrl.hostname.toLowerCase())) throw new Error("Medal redirected the clip page to an unsupported host.");
  if (!pageResponse.ok) throw new Error(`Medal returned HTTP ${pageResponse.status} for this clip.`);
  const mediaUrl = extractMedalMediaUrl(await pageResponse.text());
  const mediaResponse = await fetch(mediaUrl, { redirect: "follow", headers: { referer: pageUrl.href } });
  const finalMediaUrl = new URL(mediaResponse.url);
  if (!MEDIA_HOST_PATTERN.test(finalMediaUrl.hostname)) throw new Error("Medal redirected the video to an unsupported media host.");
  if (!mediaResponse.ok || !mediaResponse.body) throw new Error(`The Medal video download failed with HTTP ${mediaResponse.status}.`);
  const length = Number(mediaResponse.headers.get("content-length") || 0);
  if (length > MAX_DOWNLOAD_BYTES) throw new Error("The Medal clip is larger than the 2 GB safety limit.");
  const clipId = pageUrl.pathname.split("/").filter(Boolean).at(-1)?.replace(/[^a-z0-9_-]/gi, "") || Date.now();
  const outputPath = path.join(destinationDirectory, `medal-${clipId}-${Date.now()}.mp4`);
  await pipeline(Readable.fromWeb(mediaResponse.body), byteLimit(MAX_DOWNLOAD_BYTES), fs.createWriteStream(outputPath, { flags: "wx" }));
  return { path: outputPath, sourceUrl: pageUrl.href, mediaUrl: mediaUrl.href, fromMedal: true };
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

module.exports = { validateMedalUrl, extractMedalMediaUrl, importMedalClip, MEDIA_HOST_PATTERN };
