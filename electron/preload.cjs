const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("recut", {
  pickReference: () => ipcRenderer.invoke("pick-reference"),
  pickMusic: () => ipcRenderer.invoke("pick-music"),
  pickLyrics: () => ipcRenderer.invoke("pick-lyrics"),
  pickFont: () => ipcRenderer.invoke("pick-font"),
  pickOverlay: () => ipcRenderer.invoke("pick-overlay"),
  pickClips: () => ipcRenderer.invoke("pick-clips"),
  pickOutput: () => ipcRenderer.invoke("pick-output"),
  importMedal: (url) => ipcRenderer.invoke("import-medal", url),
  inspect: (input) => ipcRenderer.invoke("inspect-project", input),
  capabilities: () => ipcRenderer.invoke("capabilities"),
  render: (input) => ipcRenderer.invoke("render-project", input),
  cancelRender: () => ipcRenderer.invoke("cancel-render"),
  reveal: (filePath) => ipcRenderer.invoke("reveal-output", filePath),
  previewUrl: (filePath) => `recut-media://preview/${encodeURIComponent(filePath)}`,
  onProgress: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on("render-progress", handler);
    return () => ipcRenderer.removeListener("render-progress", handler);
  }
});
