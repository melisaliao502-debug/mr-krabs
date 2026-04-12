const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("chatAPI", {
  getInitData: () => ipcRenderer.invoke("chat-get-init"),
  send: (text) => ipcRenderer.send("chat-send", text),
  addTask: (text) => ipcRenderer.send("chat-add-task", text),
  close: () => ipcRenderer.send("chat-close"),
  resize: (height) => ipcRenderer.send("chat-resize", height),
  onForceClose: (cb) => ipcRenderer.on("chat-force-close", () => cb()),
});
