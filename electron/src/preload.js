const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('handoff', {
  // UI
  toggleCollapse:  ()         => ipcRenderer.invoke('toggle-collapse'),
  setExpanded:     (expanded) => ipcRenderer.invoke('set-expanded', expanded),
  setIgnoreMouse:  (ignore)   => ipcRenderer.invoke('set-ignore-mouse', ignore),
  getCollapsed:    ()         => ipcRenderer.invoke('get-collapsed'),

  // Step lifecycle — drives the idle timer in main process
  stepStarted:     (stepIndex) => ipcRenderer.invoke('step-started', stepIndex),
  sessionEnded:    ()          => ipcRenderer.invoke('session-ended'),

  // Screen capture
  captureScreen:   ()         => ipcRenderer.invoke('capture-screen'),

  // Vision analysis — proxied through main process to avoid renderer network crashes
  analyzeScreen:   (payload)  => ipcRenderer.invoke('analyze-screen', payload),

  // Idle alerts pushed from main → renderer
  onIdleAlert:     (cb) => { ipcRenderer.on('idle-alert', (_, payload) => cb(payload)) },
  offIdleAlert:    ()   => { ipcRenderer.removeAllListeners('idle-alert') },

  // Ghost cursor control (called from overlay window)
  showGhostCursor: (payload) => ipcRenderer.invoke('show-ghost-cursor', payload),
  hideGhostCursor: ()        => ipcRenderer.invoke('hide-ghost-cursor'),

  // Ghost cursor position events (received in ghost-cursor window)
  onGhostCursor:   (cb) => { ipcRenderer.on('ghost-cursor-move', (_, payload) => cb(payload)) },
  offGhostCursor:  ()   => { ipcRenderer.removeAllListeners('ghost-cursor-move') },
})
