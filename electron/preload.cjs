const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("pmShell", {
  getHover: () => ipcRenderer.invoke("hover:get"),
  toggleHover: () => ipcRenderer.invoke("hover:toggle"),
  onHover: (cb) => {
    const h = (_e, on) => cb(on === true);
    ipcRenderer.on("hover:changed", h);
    return () => ipcRenderer.removeListener("hover:changed", h);
  },
});
