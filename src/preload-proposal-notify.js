const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("proposalAPI", {
  getData: () => ipcRenderer.invoke("proposal-notify-get-data"),
  accept: (lineIndex) => ipcRenderer.send("proposal-notify-accept", lineIndex),
  reject: (lineIndex) => ipcRenderer.send("proposal-notify-reject", lineIndex),
  supplement: (lineIndex, text) => ipcRenderer.send("proposal-notify-supplement", lineIndex, text),
  resize: (height) => ipcRenderer.send("proposal-notify-resize", height),
  dismiss: () => ipcRenderer.send("proposal-notify-dismiss"),
});
