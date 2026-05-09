const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  loadPrefs:    () => ipcRenderer.invoke("prefs:load"),
  savePrefs:    (d) => ipcRenderer.invoke("prefs:save", d),
  env:          () => ipcRenderer.invoke("env:get"),
  openExternal: (url) => ipcRenderer.invoke("shell:openExternal", url),
});
