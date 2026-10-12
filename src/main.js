import "./style.css";

const state = {
  referencePath: "",
  musicPath: "",
  lyricsPath: "",
  lyricsText: "",
  lyricsQuality: "auto",
  lyricsLanguage: "",
  fontPath: "",
  fontName: "",
  overlayPath: "",
  overlayPosition: "top-right",
  instructions: "",
  removeMedalWatermark: false,
  watermarkScope: "medal",
  watermarkMode: "auto",
  fontImagePath: "",
  fontSampleText: "",
  medalClipPaths: [],
  impactOverrides: {},
  editingStyle: "balanced",
  renderQuality: "standard",
  sourceVolume: 0.72,
  musicVolume: 0.82,
  clipPaths: [],
  outputDirectory: "",
  duration: 30,
  aspectRatio: "16:9",
  busy: false,
  analysis: null,
  result: null
};

const DRAFT_FIELDS = [
  "referencePath", "musicPath", "lyricsPath", "lyricsText", "lyricsQuality", "lyricsLanguage",
  "fontPath", "fontName", "overlayPath", "overlayPosition", "fontImagePath", "fontSampleText",
  "instructions", "removeMedalWatermark", "watermarkScope", "watermarkMode", "medalClipPaths", "impactOverrides", "editingStyle", "renderQuality",
  "sourceVolume", "musicVolume", "clipPaths", "outputDirectory", "duration", "aspectRatio"
];

try {
  const saved = JSON.parse(localStorage.getItem("recut-draft-v1") || "null");
  if (saved && typeof saved === "object") {
    for (const key of DRAFT_FIELDS) if (key in saved) state[key] = saved[key];
  }
} catch { /* a broken draft should never prevent the editor from opening */ }

const app = document.querySelector("#app");

app.innerHTML = `
  <div class="shell">
    <header class="topbar">
      <a class="brand" href="#" aria-label="ReCut home">
        <span class="brand-mark"><i></i><i></i><i></i></span>
        <span>ReCut</span>
      </a>
      <div class="top-meta" id="capabilityStatus" title="Checking local tools"><span class="status-dot"></span><span id="capabilityText">Checking local tools</span><span class="version">v0.8</span></div>
    </header>

    <main>
      <section class="hero">
        <p class="eyebrow">REFERENCE-GUIDED GAMING EDITS</p>
        <h1>Your clips.<br><span>Their rhythm.</span></h1>
        <p class="lede">Turn raw gaming highlights into a tight 30-second montage inspired by a reference edit — then keep editing in DaVinci Resolve Free.</p>
      </section>

      <section class="workspace" aria-label="Montage setup">
        <div class="steps">
          <article class="step-card" data-kind="reference">
            <div class="step-number">01</div>
            <div class="step-copy">
              <h2>Reference edit</h2>
              <p>We read its cuts, impact effects, pace, beats and color.</p>
              <button class="file-button" id="pickReference"><span>Choose reference</span><kbd>MP4</kbd></button>
              <div class="file-value" id="referenceValue">Nothing selected</div>
            </div>
          </article>

          <article class="step-card" data-kind="clips">
            <div class="step-number">02</div>
            <div class="step-copy">
              <h2>Gaming clips</h2>
              <p>Pick one or more highlights. Choose again to add more.</p>
              <button class="file-button" id="pickClips"><span>Add clips</span><kbd>1 OR MORE</kbd></button>
              <div class="file-value" id="clipsValue">No clips selected</div>
              <div class="clip-queue" id="clipQueue"></div>
              <div class="inline-import medal-import">
                <textarea id="medalUrl" rows="2" placeholder="Paste one or more Medal.tv clip links (one per line)" aria-label="Medal.tv clip links"></textarea>
                <button id="importMedal">Import</button>
              </div>
              <div class="file-value" id="medalValue">Medal links are downloaded once and cached</div>
            </div>
          </article>

          <article class="step-card optional" data-kind="music">
            <div class="step-number">03</div>
            <div class="step-copy">
              <h2>Music <em>optional</em></h2>
              <p>Without a track, the reference audio is used.</p>
              <button class="file-button" id="pickMusic"><span>Choose music</span><kbd>AUDIO</kbd></button>
              <div class="file-value" id="musicValue">Using reference audio</div>
              <button class="file-button secondary-file" id="pickLyrics"><span>Exact timed lyrics <em>optional</em></span><kbd>LRC / SRT</kbd></button>
              <div class="file-value" id="lyricsValue">Automatic song transcription</div>
              <textarea class="lyrics-text" id="lyricsText" rows="4" placeholder="Paste the song text (optional). The whole song is fine — ReCut finds the part that plays and fixes misheard words. LRC with [00:12.30] timestamps works too."></textarea>
              <div class="asset-grid lyric-options">
                <select id="lyricsQuality" aria-label="Lyric recognition quality">
                  <option value="auto">Recognition: auto (GPU → best)</option>
                  <option value="fast">Recognition: fast</option>
                  <option value="accurate">Recognition: accurate</option>
                  <option value="best">Recognition: best (slow on CPU)</option>
                </select>
                <select id="lyricsLanguage" aria-label="Song language">
                  <option value="">Language: detect</option>
                  <option value="de">Language: German</option>
                  <option value="en">Language: English</option>
                  <option value="es">Language: Spanish</option>
                  <option value="fr">Language: French</option>
                </select>
              </div>
            </div>
          </article>

          <article class="step-card optional" data-kind="assets">
            <div class="step-number">04</div>
            <div class="step-copy">
              <h2>Overlay assets <em>optional</em></h2>
              <p>Use a local font and a PNG/WebP/JPG asset in the final video.</p>
              <div class="asset-grid">
                <button class="file-button" id="pickFont"><span>Custom font</span><kbd>TTF / OTF</kbd></button>
                <input id="fontName" type="text" placeholder="Font family name (e.g. Inter)" />
                <button class="file-button" id="pickOverlay"><span>Image overlay</span><kbd>PNG / WEBP</kbd></button>
                <select id="overlayPosition" aria-label="Overlay position">
                  <option value="top-right">Top right</option><option value="top-left">Top left</option>
                  <option value="bottom-right">Bottom right</option><option value="bottom-left">Bottom left</option>
                </select>
              </div>
              <div class="file-value" id="assetsValue">Bundled fonts · no image overlay</div>
              <div class="font-match">
                <p>Font from an image — choose a screenshot (e.g. from the reference edit) and type the text it shows.</p>
                <div class="asset-grid">
                  <button class="file-button" id="pickFontImage"><span>Text screenshot</span><kbd>PNG / JPG</kbd></button>
                  <input id="fontSampleText" type="text" placeholder="Text in the image (e.g. HEADSHOT)" />
                </div>
                <button class="match-button" id="matchFont">Find matching font</button>
                <div class="font-results" id="fontResults"></div>
              </div>
            </div>
          </article>
        </div>

        <aside class="control-panel">
          <div class="panel-heading">
            <span>OUTPUT</span>
            <span class="ready-state" id="readyState">SETUP NEEDED</span>
          </div>

          <label class="control-label" for="duration">Montage length <output id="durationValue">30 sec</output></label>
          <input id="duration" type="range" min="15" max="45" value="30" step="1" />
          <div class="range-labels"><span>15</span><span>30</span><span>45</span></div>

          <fieldset>
            <legend>Aspect ratio</legend>
            <div class="segmented">
              <button class="ratio active" data-ratio="16:9">16:9 <small>YouTube</small></button>
              <button class="ratio" data-ratio="9:16">9:16 <small>Shorts</small></button>
            </div>
          </fieldset>

          <fieldset>
            <legend>Editing style</legend>
            <div class="segmented three-way" id="stylePicker">
              <button class="style-choice" data-style="cinematic">Cinematic<small>slow + clean</small></button>
              <button class="style-choice active" data-style="balanced">Balanced<small>adaptive</small></button>
              <button class="style-choice" data-style="aggressive">Aggressive<small>fast + strict</small></button>
            </div>
          </fieldset>

          <fieldset>
            <legend>Render quality</legend>
            <div class="segmented three-way" id="qualityPicker">
              <button class="quality-choice" data-quality="draft">Draft<small>fast</small></button>
              <button class="quality-choice active" data-quality="standard">High<small>default</small></button>
              <button class="quality-choice" data-quality="master">Master<small>large</small></button>
            </div>
          </fieldset>

          <fieldset class="audio-mix">
            <legend>Audio mix</legend>
            <label for="sourceVolume">Game <output id="sourceVolumeValue">72%</output></label>
            <input id="sourceVolume" type="range" min="0" max="1.5" value="0.72" step="0.01" />
            <label for="musicVolume">Music <output id="musicVolumeValue">82%</output></label>
            <input id="musicVolume" type="range" min="0" max="1.5" value="0.82" step="0.01" />
          </fieldset>

          <label class="control-label" for="instructions">Edit instructions</label>
          <textarea id="instructions" rows="3" placeholder="e.g. Die Kills sind immer am Ende der Clips · exakt auf den Beat · keine Slowmo · Wasserzeichen bei allen Clips entfernen"></textarea>
          <div class="instruction-chips" id="instructionChips"></div>
          <label class="check-control"><input id="removeWatermark" type="checkbox" /> Remove watermark</label>
          <div class="watermark-options" id="watermarkOptions">
            <select id="watermarkScope" aria-label="Watermark clips">
              <option value="medal">Medal imports only</option>
              <option value="all">All clips</option>
            </select>
            <select id="watermarkMode" aria-label="Watermark method">
              <option value="auto">Detect + erase</option>
              <option value="crop">Crop edges</option>
            </select>
          </div>

          <button class="output-picker" id="pickOutput">
            <span><small>Save result to</small><strong id="outputValue">Choose a folder</strong></span>
            <span aria-hidden="true">↗</span>
          </button>

          <button class="analyze-button" id="analyzeButton" disabled>
            <span>Analyze edit</span><span>→</span>
          </button>
          <button class="render-button" id="renderButton" disabled>
            <span>Create montage</span><span>✦</span>
          </button>
          <p class="privacy">Files stay on this computer. Nothing is uploaded.</p>
        </aside>
      </section>

      <section class="analysis-card hidden" id="analysisCard">
        <div>
          <p class="eyebrow">EDIT BLUEPRINT</p>
          <h2 id="analysisTitle">Reference analyzed</h2>
        </div>
        <div class="metrics" id="metrics"></div>
      </section>

      <section class="storyboard hidden" id="storyboard">
        <div class="storyboard-heading">
          <div><p class="eyebrow">HUMAN REVIEW</p><h2>Check every key moment.</h2></div>
          <p>Move the marker when automation picked the wrong hit. Your reviewed values are used during render.</p>
        </div>
        <div class="review-grid" id="reviewGrid"></div>
      </section>

      <section class="progress-card hidden" id="progressCard" aria-live="polite">
        <div class="progress-copy"><span id="progressMessage">Preparing</span><div><button class="cancel-render hidden" id="cancelRender">Cancel</button><strong id="progressPercent">0%</strong></div></div>
        <div class="progress-track"><div id="progressBar"></div></div>
      </section>

      <section class="result-card hidden" id="resultCard">
        <div class="result-icon">✓</div>
        <div>
          <p class="eyebrow">EXPORT COMPLETE</p>
          <h2>Your montage is ready.</h2>
          <p id="resultSummary">Preview video, lyric captions, editable Resolve timeline and analysis report were created.</p>
        </div>
        <button id="revealButton">Show files <span>↗</span></button>
      </section>
      <section class="preview-card hidden" id="previewCard">
        <div class="preview-heading"><span>FINAL PREVIEW</span><span id="previewMeta"></span></div>
        <video id="resultVideo" controls playsinline preload="metadata"></video>
      </section>
    </main>

    <footer><span>Built for editors, not algorithms.</span><span>DaVinci Resolve Free · FFmpeg · Offline</span></footer>
  </div>
`;

const byId = (id) => document.querySelector(`#${id}`);
const basename = (filePath) => filePath?.split(/[\\/]/).pop() || "";

function updateUi() {
  byId("referenceValue").textContent = state.referencePath ? basename(state.referencePath) : "Nothing selected";
  byId("clipsValue").textContent = state.clipPaths.length
    ? `${state.clipPaths.length} clip${state.clipPaths.length === 1 ? "" : "s"} selected`
    : "No clips selected";
  byId("musicValue").textContent = state.musicPath ? basename(state.musicPath) : "Using reference audio";
  byId("lyricsValue").textContent = state.lyricsPath
    ? basename(state.lyricsPath)
    : state.lyricsText.trim() ? "Pasted song text · aligned to the audio" : "Automatic song transcription";
  byId("watermarkOptions").classList.toggle("hidden", !state.removeMedalWatermark);
  byId("assetsValue").textContent = [
    state.fontPath ? basename(state.fontPath) : "Bundled fonts",
    state.overlayPath ? basename(state.overlayPath) : "no image overlay"
  ].join(" · ");
  byId("outputValue").textContent = state.outputDirectory || "Choose a folder";
  byId("durationValue").textContent = `${state.duration} sec`;
  byId("sourceVolumeValue").textContent = `${Math.round(state.sourceVolume * 100)}%`;
  byId("musicVolumeValue").textContent = `${Math.round(state.musicVolume * 100)}%`;
  renderClipQueue();

  const canAnalyze = Boolean(state.referencePath && state.clipPaths.length >= 1);
  const canRender = Boolean(canAnalyze && state.outputDirectory && state.analysis);
  byId("analyzeButton").disabled = !canAnalyze || state.busy;
  byId("renderButton").disabled = !canRender || state.busy;
  byId("readyState").textContent = canRender ? "READY TO RENDER" : canAnalyze ? "READY TO ANALYZE" : "ADD REFERENCE + CLIP";
  byId("readyState").classList.toggle("ready", canAnalyze);
  saveDraft();
}

async function choose(handler, assign) {
  if (state.busy) return;
  const values = await handler();
  if (values?.length) {
    assign(values);
    state.analysis = null;
    state.result = null;
    byId("analysisCard").classList.add("hidden");
    byId("storyboard").classList.add("hidden");
    byId("resultCard").classList.add("hidden");
    byId("previewCard").classList.add("hidden");
    updateUi();
  }
}

byId("pickReference").addEventListener("click", () => choose(window.recut.pickReference, ([value]) => { state.referencePath = value; }));
byId("pickClips").addEventListener("click", () => choose(window.recut.pickClips, (values) => {
  state.clipPaths = [...new Set([...state.clipPaths, ...values])];
}));
byId("pickMusic").addEventListener("click", () => choose(window.recut.pickMusic, ([value]) => { state.musicPath = value; }));
byId("pickLyrics").addEventListener("click", () => choose(window.recut.pickLyrics, ([value]) => { state.lyricsPath = value; }));
byId("pickFont").addEventListener("click", () => choose(window.recut.pickFont, ([value]) => useFont(value)));

async function useFont(fontPath, family = "") {
  state.fontPath = fontPath;
  state.fontName = family || basename(fontPath).replace(/\.(ttf|otf|woff2?)$/i, "").replace(/[-_]+/g, " ");
  byId("fontName").value = state.fontName;
  updateUi();
  if (family) return;
  try {
    const info = await window.recut.fontInfo(fontPath);
    if (info?.family && state.fontPath === fontPath) {
      state.fontName = info.family;
      byId("fontName").value = info.family;
      updateUi();
    }
  } catch { /* the filename guess stays editable */ }
}

byId("pickFontImage").addEventListener("click", async () => {
  const [value] = await window.recut.pickFontImage();
  if (!value) return;
  state.fontImagePath = value;
  byId("pickFontImage").querySelector("span").textContent = basename(value);
  saveDraft();
});
byId("fontSampleText").addEventListener("input", (event) => { state.fontSampleText = event.target.value; saveDraft(); });
byId("matchFont").addEventListener("click", async () => {
  const results = byId("fontResults");
  if (!state.fontImagePath) { results.innerHTML = `<span class="hint">Choose a screenshot first.</span>`; return; }
  if (!state.fontSampleText.trim()) { results.innerHTML = `<span class="hint">Type the text that is visible in the image.</span>`; return; }
  byId("matchFont").disabled = true;
  results.innerHTML = `<span class="hint">Comparing installed fonts…</span>`;
  const stop = window.recut.onFontProgress(({ done, total }) => {
    results.innerHTML = `<span class="hint">Comparing installed fonts… ${done}/${total}</span>`;
  });
  try {
    const { candidates } = await window.recut.matchFont({ imagePath: state.fontImagePath, text: state.fontSampleText });
    results.innerHTML = candidates.map((item, index) => `
      <button class="font-choice${item.fontPath === state.fontPath ? " active" : ""}" data-path="${escapeHtml(item.fontPath)}" data-family="${escapeHtml(item.family)}">
        <b>${index + 1}</b><span>${escapeHtml(item.family)} <small>${escapeHtml(item.style)}</small></span><em>${Math.round(Math.max(0, item.score) * 100)}%</em>
      </button>`).join("") || `<span class="hint">No match found.</span>`;
    results.querySelectorAll(".font-choice").forEach((button) => button.addEventListener("click", () => {
      results.querySelectorAll(".font-choice").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      useFont(button.dataset.path, button.dataset.family);
    }));
  } catch (error) {
    results.innerHTML = `<span class="hint error">${escapeHtml(error.message || String(error))}</span>`;
  } finally {
    stop();
    byId("matchFont").disabled = false;
  }
});
byId("pickOverlay").addEventListener("click", () => choose(window.recut.pickOverlay, ([value]) => { state.overlayPath = value; }));
byId("pickOutput").addEventListener("click", () => choose(window.recut.pickOutput, ([value]) => { state.outputDirectory = value; }));

byId("importMedal").addEventListener("click", async () => {
  if (state.busy || !byId("medalUrl").value.trim()) return;
  setBusy(true, "Importing Medal…");
  const stop = window.recut.onMedalProgress(({ index, total }) => {
    byId("medalValue").textContent = `Downloading ${index + 1} of ${total}…`;
  });
  try {
    const { imported, failed } = await window.recut.importMedal(byId("medalUrl").value.trim());
    const paths = imported.map((item) => item.path);
    state.clipPaths = [...new Set([...state.clipPaths, ...paths])];
    state.medalClipPaths = [...new Set([...state.medalClipPaths, ...paths])];
    byId("medalUrl").value = failed.map((item) => item.link).join("\n");
    byId("medalValue").textContent = [
      imported.length ? `${imported.length} clip${imported.length === 1 ? "" : "s"} imported` : "",
      failed.length ? `${failed.length} failed: ${failed[0].error}` : ""
    ].filter(Boolean).join(" · ");
    byId("medalValue").classList.toggle("error", failed.length > 0);
    if (imported.length) invalidateAnalysis();
  } catch (error) {
    showError(error);
  } finally {
    stop();
    setBusy(false);
    updateUi();
  }
});

byId("fontName").addEventListener("input", (event) => { state.fontName = event.target.value; });
byId("overlayPosition").addEventListener("change", (event) => { state.overlayPosition = event.target.value; });
byId("instructions").addEventListener("input", (event) => {
  state.instructions = event.target.value;
  state.analysis = null;
  updateUi();
  scheduleInstructionPreview();
});
byId("removeWatermark").addEventListener("change", (event) => { state.removeMedalWatermark = event.target.checked; updateUi(); });
byId("watermarkScope").addEventListener("change", (event) => { state.watermarkScope = event.target.value; saveDraft(); });
byId("watermarkMode").addEventListener("change", (event) => { state.watermarkMode = event.target.value; saveDraft(); });
byId("lyricsText").addEventListener("input", (event) => { state.lyricsText = event.target.value; updateUi(); });
byId("lyricsQuality").addEventListener("change", (event) => { state.lyricsQuality = event.target.value; saveDraft(); });
byId("lyricsLanguage").addEventListener("change", (event) => { state.lyricsLanguage = event.target.value; saveDraft(); });

let instructionTimer = null;
function scheduleInstructionPreview() {
  clearTimeout(instructionTimer);
  instructionTimer = setTimeout(async () => {
    try {
      const parsed = await window.recut.parseInstructions(state.instructions);
      byId("instructionChips").innerHTML = parsed.labels.map((label) => `<span>${escapeHtml(label)}</span>`).join("")
        || (state.instructions.trim() ? `<em>No directive recognised yet</em>` : "");
    } catch { /* preview only */ }
  }, 220);
}
byId("sourceVolume").addEventListener("input", (event) => { state.sourceVolume = Number(event.target.value); updateUi(); });
byId("musicVolume").addEventListener("input", (event) => { state.musicVolume = Number(event.target.value); updateUi(); });

document.querySelectorAll(".style-choice").forEach((button) => button.addEventListener("click", () => {
  document.querySelectorAll(".style-choice").forEach((item) => item.classList.remove("active"));
  button.classList.add("active");
  state.editingStyle = button.dataset.style;
}));

document.querySelectorAll(".quality-choice").forEach((button) => button.addEventListener("click", () => {
  document.querySelectorAll(".quality-choice").forEach((item) => item.classList.remove("active"));
  button.classList.add("active");
  state.renderQuality = button.dataset.quality;
}));

byId("duration").addEventListener("input", (event) => {
  state.duration = Number(event.target.value);
  state.analysis = null;
  byId("analysisCard").classList.add("hidden");
  byId("storyboard").classList.add("hidden");
  updateUi();
});

document.querySelectorAll(".ratio").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".ratio").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    state.aspectRatio = button.dataset.ratio;
  });
});

function payload() {
  return {
    referencePath: state.referencePath,
    musicPath: state.musicPath,
    lyricsPath: state.lyricsPath,
    lyricsText: state.lyricsText,
    lyricsQuality: state.lyricsQuality,
    lyricsLanguage: state.lyricsLanguage,
    fontPath: state.fontPath,
    fontName: state.fontName,
    overlayPath: state.overlayPath,
    overlayPosition: state.overlayPosition,
    instructions: state.instructions,
    removeMedalWatermark: state.removeMedalWatermark,
    watermarkScope: state.watermarkScope,
    watermarkMode: state.watermarkMode,
    medalClipPaths: state.medalClipPaths,
    impactOverrides: state.impactOverrides,
    editingStyle: state.editingStyle,
    renderQuality: state.renderQuality,
    sourceVolume: state.sourceVolume,
    musicVolume: state.musicVolume,
    analysisId: state.analysis?.analysisId,
    clipPaths: state.clipPaths,
    outputDirectory: state.outputDirectory,
    duration: state.duration,
    aspectRatio: state.aspectRatio
  };
}

byId("analyzeButton").addEventListener("click", async () => {
  byId("progressBar").classList.remove("error");
  setBusy(true, "Analyzing…");
  try {
    state.analysis = await window.recut.inspect(payload());
    showAnalysis(state.analysis);
  } catch (error) {
    showError(error);
  } finally {
    setBusy(false);
  }
});

byId("renderButton").addEventListener("click", async () => {
  byId("progressBar").classList.remove("error");
  byId("progressBar").style.width = "0";
  setBusy(true, "Rendering…");
  byId("progressCard").classList.remove("hidden");
  byId("cancelRender").classList.remove("hidden");
  byId("resultCard").classList.add("hidden");
  byId("previewCard").classList.add("hidden");
  try {
    state.result = await window.recut.render(payload());
    showAnalysis(state.result);
    const captions = state.result.captions;
    byId("resultSummary").textContent = ["ready", "provided", "aligned"].includes(captions?.status)
      ? `Created ${captions.phrases} lyric phrase${captions.phrases === 1 ? "" : "s"} and ${captions.keywords} on-beat impact word${captions.keywords === 1 ? "" : "s"}${captions.status === "aligned" ? " from your song text" : ""}${captions.vocalsSeparated ? " (vocals isolated)" : ""}.`
      : captions?.status === "disabled"
        ? "Montage created without lyrics, as instructed."
        : "Montage created. Automatic lyric transcription was unavailable on this computer (install Python + faster-whisper).";
    byId("resultCard").classList.remove("hidden");
    byId("resultVideo").src = window.recut.previewUrl(state.result.previewPath);
    byId("previewMeta").textContent = `${state.result.outputProfile.width}×${state.result.outputProfile.height} · ${state.result.outputProfile.fps} FPS`;
    byId("previewCard").classList.remove("hidden");
    byId("resultCard").scrollIntoView({ behavior: "smooth", block: "center" });
  } catch (error) {
    showError(error);
  } finally {
    byId("cancelRender").classList.add("hidden");
    setBusy(false);
  }
});

byId("cancelRender").addEventListener("click", async () => {
  byId("cancelRender").disabled = true;
  byId("progressMessage").textContent = "Cancelling after the current operation…";
  await window.recut.cancelRender();
  byId("cancelRender").disabled = false;
});

byId("revealButton").addEventListener("click", () => {
  if (state.result?.previewPath) window.recut.reveal(state.result.previewPath);
});

window.recut.onProgress(({ percent, message }) => {
  byId("progressMessage").textContent = message;
  byId("progressPercent").textContent = `${percent}%`;
  byId("progressBar").style.width = `${percent}%`;
});

function setBusy(busy, label = "") {
  state.busy = busy;
  if (busy) {
    byId("analyzeButton").querySelector("span").textContent = label;
  } else {
    byId("analyzeButton").querySelector("span").textContent = "Analyze edit";
  }
  updateUi();
}

function showAnalysis(data) {
  byId("analysisCard").classList.remove("hidden");
  byId("analysisTitle").textContent = `${data.segments} edit moments mapped`;
  const metrics = [
    ["CUTS", data.cuts],
    ["AUDIO PEAKS", data.detectedBeats],
    ["KEY MOMENTS", data.keyMoments || 0],
    ["MULTI-KILLS", data.multiKillMoments || 0],
    ["D-TAPS", data.doubleTapMoments || 0],
    ["HIT SYNC", `${Math.round((data.averageHitSyncError || 0) * 1000)}ms`],
    ["LENGTH", `${Math.round(data.duration)}s`],
    ["FORMAT", state.aspectRatio]
  ];
  byId("metrics").innerHTML = metrics.map(([label, value]) => `<div><strong>${value}</strong><span>${label}</span></div>`).join("");
  if (data.clipInsights) showStoryboard(data.clipInsights);
  updateUi();
}

function renderClipQueue() {
  const queue = byId("clipQueue");
  if (!queue) return;
  queue.innerHTML = state.clipPaths.map((clipPath, index) => `
    <div class="queue-item" data-path="${escapeHtml(clipPath)}">
      <span><b>${String(index + 1).padStart(2, "0")}</b>${escapeHtml(basename(clipPath))}</span>
      <div>
        <button data-action="up" aria-label="Move clip up" ${index === 0 ? "disabled" : ""}>↑</button>
        <button data-action="down" aria-label="Move clip down" ${index === state.clipPaths.length - 1 ? "disabled" : ""}>↓</button>
        <button data-action="remove" aria-label="Remove clip">×</button>
      </div>
    </div>`).join("");
  queue.querySelectorAll("button").forEach((button) => button.addEventListener("click", () => {
    const item = button.closest(".queue-item");
    const clipPath = item.dataset.path;
    const index = state.clipPaths.indexOf(clipPath);
    if (button.dataset.action === "remove") {
      state.clipPaths.splice(index, 1);
      state.medalClipPaths = state.medalClipPaths.filter((value) => value !== clipPath);
      delete state.impactOverrides[clipPath];
    } else {
      const target = button.dataset.action === "up" ? index - 1 : index + 1;
      [state.clipPaths[index], state.clipPaths[target]] = [state.clipPaths[target], state.clipPaths[index]];
    }
    invalidateAnalysis();
  }));
}

function showStoryboard(insights) {
  byId("storyboard").classList.remove("hidden");
  byId("reviewGrid").innerHTML = insights.map((item, index) => {
    const selected = Number.isFinite(Number(state.impactOverrides[item.path]))
      ? Number(state.impactOverrides[item.path]) : item.impactTime;
    const confidence = Math.round(Math.min(1, Math.max(0, item.impactScore || 0)) * 100);
    const box = item.watermark && state.removeMedalWatermark && item.width
      ? `<i class="watermark-box" title="Detected watermark (${escapeHtml(item.watermark.corner)})" style="left:${(item.watermark.x / item.width) * 100}%;top:${(item.watermark.y / item.height) * 100}%;width:${(item.watermark.w / item.width) * 100}%;height:${(item.watermark.h / item.height) * 100}%"></i>`
      : "";
    const ticks = (item.keyMoments || []).map((moment) =>
      `<i class="moment-tick ${moment.type}" style="left:${(moment.time / item.duration) * 100}%" title="${escapeHtml(moment.type)} · ${moment.time.toFixed(2)}s" data-time="${moment.time}"></i>`).join("");
    return `<article class="review-card" data-path="${escapeHtml(item.path)}">
      <div class="review-image">${item.thumbnail ? `<img src="${item.thumbnail}" alt="Detected key moment in ${escapeHtml(item.name)}" />` : "<span>No preview</span>"}${box}<b>${String(index + 1).padStart(2, "0")}</b></div>
      <div class="review-copy">
        <div><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.keyMomentType || "impact")} · ${confidence}% signal · ${(item.keyMoments || []).length} moment${(item.keyMoments || []).length === 1 ? "" : "s"}</span></div>
        <output>${selected.toFixed(2)}s</output>
      </div>
      <div class="moment-track">${ticks}</div>
      <input class="impact-slider" type="range" min="0.05" max="${Math.max(0.1, item.duration - 0.05)}" value="${selected}" step="0.05" aria-label="Key moment for ${escapeHtml(item.name)}" />
      <div class="review-scale"><span>start</span><button class="reset-impact">Use auto</button><span>${item.duration.toFixed(1)}s</span></div>
    </article>`;
  }).join("");
  byId("reviewGrid").querySelectorAll(".review-card").forEach((card) => {
    const slider = card.querySelector(".impact-slider");
    slider.addEventListener("input", () => {
      state.impactOverrides[card.dataset.path] = Number(slider.value);
      card.querySelector("output").textContent = `${Number(slider.value).toFixed(2)}s`;
    });
    card.querySelectorAll(".moment-tick").forEach((tick) => tick.addEventListener("click", () => {
      slider.value = tick.dataset.time;
      slider.dispatchEvent(new Event("input"));
    }));
    card.querySelector(".reset-impact").addEventListener("click", () => {
      const insight = insights.find((item) => item.path === card.dataset.path);
      const auto = insight.autoImpactTime ?? insight.impactTime;
      delete state.impactOverrides[card.dataset.path];
      slider.value = auto;
      card.querySelector("output").textContent = `${auto.toFixed(2)}s`;
    });
  });
}

function invalidateAnalysis() {
  state.analysis = null;
  state.result = null;
  byId("analysisCard").classList.add("hidden");
  byId("storyboard").classList.add("hidden");
  byId("resultCard").classList.add("hidden");
  byId("previewCard").classList.add("hidden");
  updateUi();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function saveDraft() {
  try {
    const draft = Object.fromEntries(DRAFT_FIELDS.map((key) => [key, state[key]]));
    localStorage.setItem("recut-draft-v1", JSON.stringify(draft));
  } catch { /* persistence is a convenience, not a render dependency */ }
}

function showError(error) {
  const message = error?.message || String(error);
  byId("progressCard").classList.remove("hidden");
  byId("progressMessage").textContent = message;
  byId("progressPercent").textContent = "ERROR";
  byId("progressBar").style.width = "100%";
  byId("progressBar").classList.add("error");
}

byId("instructions").value = state.instructions;
byId("removeWatermark").checked = state.removeMedalWatermark;
byId("watermarkScope").value = state.watermarkScope;
byId("watermarkMode").value = state.watermarkMode;
byId("lyricsText").value = state.lyricsText;
byId("lyricsQuality").value = state.lyricsQuality;
byId("lyricsLanguage").value = state.lyricsLanguage;
byId("fontSampleText").value = state.fontSampleText;
if (state.fontImagePath) byId("pickFontImage").querySelector("span").textContent = basename(state.fontImagePath);
scheduleInstructionPreview();
byId("fontName").value = state.fontName;
byId("overlayPosition").value = state.overlayPosition;
byId("duration").value = state.duration;
byId("sourceVolume").value = state.sourceVolume;
byId("musicVolume").value = state.musicVolume;
document.querySelectorAll(".ratio").forEach((item) => item.classList.toggle("active", item.dataset.ratio === state.aspectRatio));
document.querySelectorAll(".style-choice").forEach((item) => item.classList.toggle("active", item.dataset.style === state.editingStyle));
document.querySelectorAll(".quality-choice").forEach((item) => item.classList.toggle("active", item.dataset.quality === state.renderQuality));
updateUi();

window.recut.capabilities().then((capabilities) => {
  byId("capabilityText").textContent = capabilities.lyrics.available
    ? `Local AI ready${capabilities.lyrics.vocalSeparation ? " · vocal isolation" : ""}`
    : "Local edit ready · lyrics optional";
  byId("capabilityStatus").title = [
    capabilities.lyrics.available ? "FFmpeg and automatic lyric captions are ready." : capabilities.lyrics.message,
    capabilities.lyrics.vocalSeparation ? "Demucs vocal isolation is installed." : "Optional: pip install demucs for cleaner lyric timing.",
    capabilities.ytDlp ? "yt-dlp is available as Medal fallback." : "Optional: install yt-dlp as Medal download fallback."
  ].join(" ");
  document.querySelector(".status-dot").classList.toggle("partial", !capabilities.lyrics.available);
}).catch(() => {
  byId("capabilityText").textContent = "Local processing";
});
