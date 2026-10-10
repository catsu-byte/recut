import "./style.css";

const state = {
  referencePath: "",
  musicPath: "",
  clipPaths: [],
  outputDirectory: "",
  duration: 30,
  aspectRatio: "16:9",
  busy: false,
  analysis: null,
  result: null
};

const app = document.querySelector("#app");

app.innerHTML = `
  <div class="shell">
    <header class="topbar">
      <a class="brand" href="#" aria-label="ReCut home">
        <span class="brand-mark"><i></i><i></i><i></i></span>
        <span>ReCut</span>
      </a>
      <div class="top-meta"><span class="status-dot"></span> Local processing <span class="version">v0.1</span></div>
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
              <p>We read its cuts, pace, beats and intensity.</p>
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
            </div>
          </article>

          <article class="step-card optional" data-kind="music">
            <div class="step-number">03</div>
            <div class="step-copy">
              <h2>Music <em>optional</em></h2>
              <p>Without a track, the reference audio is used.</p>
              <button class="file-button" id="pickMusic"><span>Choose music</span><kbd>AUDIO</kbd></button>
              <div class="file-value" id="musicValue">Using reference audio</div>
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

      <section class="progress-card hidden" id="progressCard" aria-live="polite">
        <div class="progress-copy"><span id="progressMessage">Preparing</span><strong id="progressPercent">0%</strong></div>
        <div class="progress-track"><div id="progressBar"></div></div>
      </section>

      <section class="result-card hidden" id="resultCard">
        <div class="result-icon">✓</div>
        <div>
          <p class="eyebrow">EXPORT COMPLETE</p>
          <h2>Your montage is ready.</h2>
          <p>Preview video, editable Resolve timeline and analysis report were created.</p>
        </div>
        <button id="revealButton">Show files <span>↗</span></button>
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
  byId("outputValue").textContent = state.outputDirectory || "Choose a folder";
  byId("durationValue").textContent = `${state.duration} sec`;

  const canAnalyze = Boolean(state.referencePath && state.clipPaths.length >= 1);
  const canRender = Boolean(canAnalyze && state.outputDirectory && state.analysis);
  byId("analyzeButton").disabled = !canAnalyze || state.busy;
  byId("renderButton").disabled = !canRender || state.busy;
  byId("readyState").textContent = canRender ? "READY TO RENDER" : canAnalyze ? "READY TO ANALYZE" : "ADD REFERENCE + CLIP";
  byId("readyState").classList.toggle("ready", canAnalyze);
}

async function choose(handler, assign) {
  if (state.busy) return;
  const values = await handler();
  if (values?.length) {
    assign(values);
    state.analysis = null;
    state.result = null;
    byId("analysisCard").classList.add("hidden");
    byId("resultCard").classList.add("hidden");
    updateUi();
  }
}

byId("pickReference").addEventListener("click", () => choose(window.recut.pickReference, ([value]) => { state.referencePath = value; }));
byId("pickClips").addEventListener("click", () => choose(window.recut.pickClips, (values) => {
  state.clipPaths = [...new Set([...state.clipPaths, ...values])];
}));
byId("pickMusic").addEventListener("click", () => choose(window.recut.pickMusic, ([value]) => { state.musicPath = value; }));
byId("pickOutput").addEventListener("click", () => choose(window.recut.pickOutput, ([value]) => { state.outputDirectory = value; }));

byId("duration").addEventListener("input", (event) => {
  state.duration = Number(event.target.value);
  state.analysis = null;
  byId("analysisCard").classList.add("hidden");
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
    clipPaths: state.clipPaths,
    outputDirectory: state.outputDirectory,
    duration: state.duration,
    aspectRatio: state.aspectRatio
  };
}

byId("analyzeButton").addEventListener("click", async () => {
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
  setBusy(true, "Rendering…");
  byId("progressCard").classList.remove("hidden");
  byId("resultCard").classList.add("hidden");
  try {
    state.result = await window.recut.render(payload());
    showAnalysis(state.result);
    byId("resultCard").classList.remove("hidden");
    byId("resultCard").scrollIntoView({ behavior: "smooth", block: "center" });
  } catch (error) {
    showError(error);
  } finally {
    setBusy(false);
  }
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
    ["LENGTH", `${Math.round(data.duration)}s`],
    ["FORMAT", state.aspectRatio]
  ];
  byId("metrics").innerHTML = metrics.map(([label, value]) => `<div><strong>${value}</strong><span>${label}</span></div>`).join("");
  updateUi();
}

function showError(error) {
  const message = error?.message || String(error);
  byId("progressCard").classList.remove("hidden");
  byId("progressMessage").textContent = message;
  byId("progressPercent").textContent = "ERROR";
  byId("progressBar").style.width = "100%";
  byId("progressBar").classList.add("error");
}

updateUi();
