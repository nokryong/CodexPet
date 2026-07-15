const { contextBridge, ipcRenderer } = require("electron");

const CHANNELS = Object.freeze({
  GET: "settings:get",
  SAVE: "settings:save",
  FONTS: "settings:fonts",
  ACCOUNT: "settings:account",
  USAGE: "settings:usage",
  APPEARANCE: "appearance:update",
  NAVIGATE: "settings:navigate",
});

contextBridge.exposeInMainWorld("settingsApi", {
  get: () => ipcRenderer.invoke(CHANNELS.GET),
  save: (value) => ipcRenderer.invoke(CHANNELS.SAVE, value),
  fonts: () => ipcRenderer.invoke(CHANNELS.FONTS),
  account: (value) => ipcRenderer.invoke(CHANNELS.ACCOUNT, value),
  usage: () => ipcRenderer.invoke(CHANNELS.USAGE),
  onAppearance: (handler) => {
    if (typeof handler !== "function") return () => {};
    const listener = (_event, value) => handler(value);
    ipcRenderer.on(CHANNELS.APPEARANCE, listener);
    return () => ipcRenderer.removeListener(CHANNELS.APPEARANCE, listener);
  },
  onNavigate: (handler) => {
    if (typeof handler !== "function") return () => {};
    const listener = (_event, section) => handler(section);
    ipcRenderer.on(CHANNELS.NAVIGATE, listener);
    return () => ipcRenderer.removeListener(CHANNELS.NAVIGATE, listener);
  },
  minimize: () => ipcRenderer.send("settings:minimize"),
  maximize: () => ipcRenderer.send("settings:maximize"),
  close: () => ipcRenderer.send("settings:close"),
  onMaximizedState: (handler) => {
    if (typeof handler !== "function") return () => {};
    const listener = (_event, isMaximized) => handler(isMaximized);
    ipcRenderer.on("settings:maximized-state", listener);
    return () => ipcRenderer.removeListener("settings:maximized-state", listener);
  },
});
