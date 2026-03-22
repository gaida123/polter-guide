const {
  app, BrowserWindow, ipcMain, screen,
  globalShortcut, desktopCapturer,
} = require('electron')
const path = require('path')
const https = require('https')
const http  = require('http')

const isDev = process.env.ELECTRON_DEV === 'true'

// ── Constants ─────────────────────────────────────────────────────────────────
const WIDGET_WIDTH  = 700
const WIDGET_HEIGHT = 220   // bar + content
const COLLAPSED_H   = 52    // bar only
const MARGIN_TOP    = 28

// Idle timeout: if no step advance in this many ms, fire an idle alert
const IDLE_TIMEOUT_MS = 20_000

let win          = null
let isCollapsed  = false
let idleTimer    = null
let currentStepIndex = -1   // -1 = not started

// ── Idle timer helpers ────────────────────────────────────────────────────────
function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
  if (currentStepIndex < 0) return          // session not active

  idleTimer = setTimeout(async () => {
    if (!win) return
    // Capture the screen then send to the renderer
    try {
      const screenshot = await captureScreen()
      win.webContents.send('idle-alert', {
        stepIndex:      currentStepIndex,
        screenshotData: screenshot,          // base64 PNG
      })
    } catch (err) {
      console.warn('[idle] capture failed:', err.message)
      win.webContents.send('idle-alert', { stepIndex: currentStepIndex, screenshotData: null })
    }
  }, IDLE_TIMEOUT_MS)
}

// ── Screen capture ────────────────────────────────────────────────────────────
async function captureScreen() {
  const sources = await desktopCapturer.getSources({
    types:     ['screen'],
    thumbnailSize: { width: 960, height: 600 },
  })
  const primary = sources[0]
  if (!primary) throw new Error('No screen source found')
  const nativeImage = primary.thumbnail
  const buf = nativeImage.toPNG()
  return buf.toString('base64')
}

// ── Create overlay window ─────────────────────────────────────────────────────
function createWindow() {
  const { width: sw } = screen.getPrimaryDisplay().workAreaSize

  win = new BrowserWindow({
    width:  WIDGET_WIDTH,
    height: COLLAPSED_H,
    x: Math.floor((sw - WIDGET_WIDTH) / 2),
    y: MARGIN_TOP,

    // ── Key overlay flags ──────────────────────────────────────────────────
    alwaysOnTop:        true,
    frame:              false,
    transparent:        true,
    hasShadow:          true,
    vibrancy:           'under-window',
    visualEffectState:  'active',
    skipTaskbar:        false,
    resizable:          false,
    movable:            true,

    // ── Security ────────────────────────────────────────────────────────────
    webPreferences: {
      preload:              path.join(__dirname, 'preload.js'),
      contextIsolation:     true,
      nodeIntegration:      false,
      backgroundThrottling: false,
    },
  })

  win.setAlwaysOnTop(true, 'screen-saver', 1)
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.setIgnoreMouseEvents(false)

  if (isDev) {
    win.loadURL('http://localhost:5173/overlay')
    // win.webContents.openDevTools({ mode: 'detach' })
  } else {
    win.loadFile(path.join(__dirname, '../frontend/dist/index.html'), {
      hash: '/overlay',
    })
  }

  win.on('closed', () => {
    win = null
    if (idleTimer) clearTimeout(idleTimer)
  })
}

// ── App ready ─────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  createWindow()

  // ── IPC: collapse / expand ────────────────────────────────────────────────
  ipcMain.handle('toggle-collapse', () => {
    if (!win) return
    isCollapsed = !isCollapsed
    const targetH = isCollapsed ? COLLAPSED_H : WIDGET_HEIGHT
    win.setSize(WIDGET_WIDTH, targetH, true)
    return isCollapsed
  })

  ipcMain.handle('set-expanded', (_, expanded) => {
    if (!win) return
    const targetH = expanded ? WIDGET_HEIGHT : COLLAPSED_H
    win.setSize(WIDGET_WIDTH, targetH, true)
  })

  ipcMain.handle('set-ignore-mouse', (_, ignore) => {
    win?.setIgnoreMouseEvents(ignore, { forward: true })
  })

  ipcMain.handle('get-collapsed', () => isCollapsed)

  // ── IPC: step lifecycle ──────────────────────────────────────────────────
  ipcMain.handle('step-started', (_, stepIndex) => {
    currentStepIndex = stepIndex
    resetIdleTimer()
  })

  ipcMain.handle('session-ended', () => {
    currentStepIndex = -1
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
  })

  // ── IPC: explicit screen capture ─────────────────────────────────────────
  ipcMain.handle('capture-screen', async () => {
    try {
      return { ok: true, data: await captureScreen() }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // ── IPC: analyze-screen proxied through main process ─────────────────────
  // Renderer network service can crash; main process Node http is stable.
  ipcMain.handle('analyze-screen', async (_, { screenshotBase64, stepIndex, instructionText }) => {
    const body = JSON.stringify({
      screenshot_base64: screenshotBase64,
      step_index:        stepIndex,
      instruction_text:  instructionText,
    })
    return new Promise((resolve) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: 8080,
        path: '/vision/analyze-screen',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 10000,
      }, (res) => {
        let data = ''
        res.on('data', chunk => { data += chunk })
        res.on('end', () => {
          try { resolve({ ok: true, data: JSON.parse(data) }) }
          catch { resolve({ ok: false, error: 'bad json' }) }
        })
      })
      req.on('error', (err) => resolve({ ok: false, error: err.message }))
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }) })
      req.write(body)
      req.end()
    })
  })

  // ── Global shortcut: Cmd+Shift+H ─────────────────────────────────────────
  globalShortcut.register('CommandOrControl+Shift+H', () => {
    if (!win) return
    if (win.isVisible()) {
      win.hide()
    } else {
      win.show()
      win.setAlwaysOnTop(true, 'screen-saver', 1)
    }
  })
})

app.on('will-quit', () => globalShortcut.unregisterAll())
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('activate', () => { if (!win) createWindow() })
