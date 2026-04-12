const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("quickTaskAPI", {
  addTask: (text) => ipcRenderer.send("quick-task-add", text),
  close: () => ipcRenderer.send("quick-task-close"),
});
