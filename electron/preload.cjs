const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("recut", {
  pickReference: () => ipcRenderer.invoke("pick-reference"),
  pickMusic: () => ipcRenderer.invoke("pick-music"),
  pickLyrics: () => ipcRenderer.invoke("pick-lyrics"),
  pickClips: () => ipcRenderer.invoke("pick-clips"),
  pickOutput: () => ipcRenderer.invoke("pick-output"),
  inspect: (input) => ipcRenderer.invoke("inspect-project", input),
  render: (input) => ipcRenderer.invoke("render-project", input),
  reveal: (filePath) => ipcRenderer.invoke("reveal-output", filePath),
  onProgress: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on("render-progress", handler);
    return () => ipcRenderer.removeListener("render-progress", handler);
  }
});
