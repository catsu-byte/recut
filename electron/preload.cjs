const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, listener) {
  const handler = (_event, payload) => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld("recut", {
  pickReference: () => ipcRenderer.invoke("pick-reference"),
  pickMusic: () => ipcRenderer.invoke("pick-music"),
  pickLyrics: () => ipcRenderer.invoke("pick-lyrics"),
  pickFont: () => ipcRenderer.invoke("pick-font"),
  pickOverlay: () => ipcRenderer.invoke("pick-overlay"),
  pickClips: () => ipcRenderer.invoke("pick-clips"),
  pickFontImage: () => ipcRenderer.invoke("pick-font-image"),
  fontInfo: (fontPath) => ipcRenderer.invoke("font-info", fontPath),
  matchFont: (request) => ipcRenderer.invoke("match-font", request),
  parseInstructions: (text) => ipcRenderer.invoke("parse-instructions", text),
  pickOutput: () => ipcRenderer.invoke("pick-output"),
  importMedal: (links) => ipcRenderer.invoke("import-medal", links),
  inspect: (input) => ipcRenderer.invoke("inspect-project", input),
  capabilities: () => ipcRenderer.invoke("capabilities"),
  render: (input) => ipcRenderer.invoke("render-project", input),
  cancelRender: () => ipcRenderer.invoke("cancel-render"),
  reveal: (filePath) => ipcRenderer.invoke("reveal-output", filePath),
  previewUrl: (filePath) => `recut-media://preview/${encodeURIComponent(filePath)}`,
  onProgress: (listener) => subscribe("render-progress", listener),
  onMedalProgress: (listener) => subscribe("medal-progress", listener),
  onFontProgress: (listener) => subscribe("font-progress", listener)
});
