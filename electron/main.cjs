const { app, BrowserWindow, dialog, ipcMain, shell, protocol, net } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { inspectProject, renderProject, assertToolchain } = require("./core/pipeline.cjs");
const { importMedalClips } = require("./core/medal.cjs");
const { checkTranscriptionEngine } = require("./core/transcriber.cjs");
const { readFontFamily, matchFontFromImage } = require("./core/fonts.cjs");
const { parseEditInstructions } = require("./core/instructions.cjs");
const { run } = require("./core/media.cjs");

const VIDEO_FILTERS = [
  { name: "Video", extensions: ["mp4", "mov", "mkv", "webm", "avi", "m4v"] }
];
const AUDIO_FILTERS = [
  { name: "Audio or video", extensions: ["mp3", "wav", "m4a", "aac", "flac", "ogg", "mp4", "mov", "mkv"] }
];
const LYRICS_FILTERS = [
  { name: "Timed lyrics", extensions: ["lrc", "srt", "vtt"] }
];
const FONT_FILTERS = [{ name: "Font", extensions: ["ttf", "otf"] }];
const IMAGE_FILTERS = [{ name: "Overlay image", extensions: ["png", "webp", "jpg", "jpeg"] }];
const SCREENSHOT_FILTERS = [{ name: "Image with text", extensions: ["png", "webp", "jpg", "jpeg", "bmp"] }];

function bundledFontsDirectory() {
  const root = path.resolve(__dirname, "..");
  return path.join(root.includes("app.asar") ? root.replace("app.asar", "app.asar.unpacked") : root, "assets", "fonts");
}

let mainWindow;
let activeRenderController = null;
const allowedPreviews = new Set();

protocol.registerSchemesAsPrivileged([{
  scheme: "recut-media",
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
}]);

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 980,
    minHeight: 700,
    backgroundColor: "#070a0d",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  if (app.isPackaged) {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  } else {
    mainWindow.loadURL("http://127.0.0.1:5173");
    mainWindow.webContents.openDevTools({ mode: "detach", activate: false });
  }
}

function pickFiles(options) {
  return dialog.showOpenDialog(mainWindow, options).then(({ canceled, filePaths }) =>
    canceled ? [] : filePaths
  );
}

app.whenReady().then(async () => {
  await assertToolchain();
  protocol.handle("recut-media", (request) => {
    const filePath = decodeURIComponent(new URL(request.url).pathname.slice(1));
    if (!allowedPreviews.has(filePath)) return new Response("Not found", { status: 404 });
    return net.fetch(pathToFileURL(filePath).href);
  });
  createWindow();

  ipcMain.handle("pick-reference", () =>
    pickFiles({ title: "Choose a reference edit", filters: VIDEO_FILTERS, properties: ["openFile"] })
  );
  ipcMain.handle("pick-music", () =>
    pickFiles({ title: "Choose music", filters: AUDIO_FILTERS, properties: ["openFile"] })
  );
  ipcMain.handle("pick-lyrics", () =>
    pickFiles({ title: "Choose timed lyrics", filters: LYRICS_FILTERS, properties: ["openFile"] })
  );
  ipcMain.handle("pick-font", () =>
    pickFiles({ title: "Choose a custom overlay font", filters: FONT_FILTERS, properties: ["openFile"] })
  );
  ipcMain.handle("pick-overlay", () =>
    pickFiles({ title: "Choose an overlay image", filters: IMAGE_FILTERS, properties: ["openFile"] })
  );
  ipcMain.handle("pick-font-image", () =>
    pickFiles({ title: "Choose an image that shows the font", filters: SCREENSHOT_FILTERS, properties: ["openFile"] })
  );
  ipcMain.handle("font-info", (_event, fontPath) => readFontFamily(fontPath));
  ipcMain.handle("match-font", (_event, { imagePath, text }) =>
    matchFontFromImage(imagePath, text, {
      extraDirectories: [bundledFontsDirectory()],
      onProgress: (payload) => mainWindow?.webContents.send("font-progress", payload)
    })
  );
  ipcMain.handle("parse-instructions", (_event, text) => parseEditInstructions(text));
  ipcMain.handle("pick-clips", () =>
    pickFiles({ title: "Choose gaming clips", filters: VIDEO_FILTERS, properties: ["openFile", "multiSelections"] })
  );
  ipcMain.handle("pick-output", async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: "Choose an output folder",
      properties: ["openDirectory", "createDirectory"]
    });
    return canceled ? [] : filePaths;
  });
  ipcMain.handle("import-medal", (_event, links) =>
    importMedalClips(links, path.join(app.getPath("userData"), "medal-imports"),
      (payload) => mainWindow?.webContents.send("medal-progress", payload))
  );
  ipcMain.handle("inspect-project", (_event, input) => inspectProject(input));
  ipcMain.handle("capabilities", async () => ({
    lyrics: await checkTranscriptionEngine(),
    ytDlp: await run(process.env.RECUT_YTDLP || "yt-dlp", ["--version"]).then(() => true, () => false),
    ffmpeg: true,
    localOnly: true
  }));
  ipcMain.handle("render-project", async (_event, input) => {
    if (activeRenderController) throw new Error("A render is already running.");
    activeRenderController = new AbortController();
    try {
      const result = await renderProject(input, (payload) => mainWindow?.webContents.send("render-progress", payload), activeRenderController.signal);
      allowedPreviews.add(result.previewPath);
      return result;
    } catch (error) {
      if (error.name === "AbortError" || activeRenderController.signal.aborted) throw new Error("Render cancelled.");
      throw error;
    } finally {
      activeRenderController = null;
    }
  });
  ipcMain.handle("cancel-render", () => {
    if (!activeRenderController) return false;
    activeRenderController.abort();
    return true;
  });
  ipcMain.handle("reveal-output", (_event, filePath) => shell.showItemInFolder(filePath));

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
