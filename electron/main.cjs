const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const path = require("node:path");
const { inspectProject, renderProject, assertToolchain } = require("./core/pipeline.cjs");

const VIDEO_FILTERS = [
  { name: "Video", extensions: ["mp4", "mov", "mkv", "webm", "avi", "m4v"] }
];
const AUDIO_FILTERS = [
  { name: "Audio or video", extensions: ["mp3", "wav", "m4a", "aac", "flac", "ogg", "mp4", "mov", "mkv"] }
];
const LYRICS_FILTERS = [
  { name: "Timed lyrics", extensions: ["lrc", "srt"] }
];

let mainWindow;

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
  ipcMain.handle("inspect-project", (_event, input) => inspectProject(input));
  ipcMain.handle("render-project", (_event, input) =>
    renderProject(input, (payload) => mainWindow?.webContents.send("render-progress", payload))
  );
  ipcMain.handle("reveal-output", (_event, filePath) => shell.showItemInFolder(filePath));

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
