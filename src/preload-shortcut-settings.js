const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("shortcutAPI", {
  /** Returns { chatShortcut, quickTaskShortcut, defaultChatShortcut, defaultQuickTaskShortcut } */
  getShortcuts: () => ipcRenderer.invoke("shortcuts-get"),

  /**
   * Attempt to register a new accelerator for the given slot.
   * @param {"chat"|"task"} which
   * @param {string} accel  Electron accelerator string, e.g. "F18+Return"
   * @returns {Promise<boolean>} true = success, false = registration failed (conflict)
   */
  setShortcut: (which, accel) => ipcRenderer.invoke("shortcuts-set", which, accel),
});
