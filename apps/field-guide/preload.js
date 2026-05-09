const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  loadPrefs:    () => ipcRenderer.invoke("prefs:load"),
  savePrefs:    (d) => ipcRenderer.invoke("prefs:save", d),
  env:          () => ipcRenderer.invoke("env:get"),
  openExternal: (url) => ipcRenderer.invoke("shell:openExternal", url),
  // app updates (electron-updater + GitHub Releases; no-op in dev)
  checkAppUpdate:        ()       => ipcRenderer.invoke("fg:check-update"),
  applyAppUpdate:        ()       => ipcRenderer.invoke("fg:apply-update"),
  applyUpdateAndRestart: ()       => ipcRenderer.invoke("fg:apply-update-and-restart"),
  getAppInfo:            ()       => ipcRenderer.invoke("fg:get-app-info"),
});
