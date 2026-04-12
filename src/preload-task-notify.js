const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("notifyAPI", {
  getData: () => ipcRenderer.invoke("task-notify-get-data"),
  submit: (supplement) => ipcRenderer.send("task-notify-submit", supplement),
  dismiss: () => ipcRenderer.send("task-notify-dismiss"),
});
