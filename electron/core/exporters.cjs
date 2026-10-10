const path = require("node:path");
const { pathToFileURL } = require("node:url");

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function frames(seconds, fps) {
  return Math.max(1, Math.round(seconds * fps));
}

function createFcpxml({ segments, musicPath, width, height, fps = 30 }) {
  const resources = segments.map((segment, index) => {
    const id = `r${index + 2}`;
    const duration = frames(segment.duration, fps);
    return `    <asset id="${id}" name="${escapeXml(path.basename(segment.renderedPath))}" start="0s" duration="${duration}/${fps}s" hasVideo="1" format="r1" src="${escapeXml(pathToFileURL(segment.renderedPath).href)}"/>`;
  });
  let musicId = null;
  if (musicPath) {
    musicId = `r${segments.length + 2}`;
    resources.push(`    <asset id="${musicId}" name="${escapeXml(path.basename(musicPath))}" start="0s" duration="${frames(segments.reduce((sum, item) => sum + item.duration, 0), fps)}/${fps}s" hasAudio="1" audioSources="1" audioChannels="2" src="${escapeXml(pathToFileURL(musicPath).href)}"/>`);
  }
  let offsetFrames = 0;
  const clips = segments.map((segment, index) => {
    const duration = frames(segment.duration, fps);
    const item = `            <asset-clip ref="r${index + 2}" offset="${offsetFrames}/${fps}s" start="0s" duration="${duration}/${fps}s" name="${escapeXml(segment.sourceName)} — ${segment.effect}"/>`;
    offsetFrames += duration;
    return item;
  });
  if (musicId) {
    clips[0] = clips[0].replace("/>", `>\n              <asset-clip ref="${musicId}" lane="-1" offset="0s" start="0s" duration="${offsetFrames}/${fps}s" name="Music"/>\n            </asset-clip>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.10">
  <resources>
    <format id="r1" name="ReCut ${width}x${height}p${fps}" frameDuration="1/${fps}s" width="${width}" height="${height}" colorSpace="1-1-1 (Rec. 709)"/>
${resources.join("\n")}
  </resources>
  <library>
    <event name="ReCut Export">
      <project name="ReCut — Reference Match">
        <sequence format="r1" duration="${offsetFrames}/${fps}s" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">
          <spine>
${clips.join("\n")}
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
`;
}

function createReport({ blueprint, plan, referencePath, musicPath, outputPath }) {
  return {
    generatedAt: new Date().toISOString(),
    referencePath,
    musicPath,
    outputPath,
    duration: blueprint.duration,
    detectedSceneCuts: blueprint.detectedSceneCuts,
    detectedBeats: blueprint.detectedBeats,
    segments: plan.map(({ index, timelineStart, duration, sourcePath, sourceStart, speed, effect, intensity, motionScore }) => ({
      index,
      timelineStart: round(timelineStart),
      duration: round(duration),
      sourcePath,
      sourceStart: round(sourceStart),
      speed: round(speed),
      effect,
      intensity: round(intensity),
      motionScore: round(motionScore)
    }))
  };
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

module.exports = { createFcpxml, createReport, escapeXml };
