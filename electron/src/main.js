const {
  app, BrowserWindow, ipcMain, screen,
  globalShortcut, desktopCapturer, session,
} = require('electron')
const path = require('path')
const https = require('https')
const http  = require('http')
const { execFile } = require('child_process')

const isDev = process.env.ELECTRON_DEV === 'true'
const ENABLE_GHOST_AUTOMATION = process.env.GHOST_AUTOMATION === 'true'

// ── Constants ─────────────────────────────────────────────────────────────────
const WIDGET_WIDTH  = 700
const WIDGET_HEIGHT = 220   // bar + content
const COLLAPSED_H   = 52    // bar only
const MARGIN_TOP    = 28

// Idle timeout: if no step advance in this many ms, fire an idle alert
const IDLE_TIMEOUT_MS = 20_000

let win          = null
let ghostWin     = null
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

function mapGhostTargetToScreen(targetX, targetY, normalized = false) {
  // Use the display nearest to the user's current cursor so ghost clicks can
  // target apps on any monitor, not just the primary display.
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const bounds = display?.bounds || { x: 0, y: 0, width: 1920, height: 1080 }
  const nX = Number(targetX)
  const nY = Number(targetY)
  if (!Number.isFinite(nX) || !Number.isFinite(nY)) {
    return {
      x: Math.round(bounds.x + (bounds.width / 2)),
      y: Math.round(bounds.y + (bounds.height / 2)),
    }
  }
  if (normalized) {
    const fx = Math.max(0, Math.min(1, nX))
    const fy = Math.max(0, Math.min(1, nY))
    return {
      x: Math.round(bounds.x + (fx * bounds.width)),
      y: Math.round(bounds.y + (fy * bounds.height)),
    }
  }
  return {
    x: Math.round(nX),
    y: Math.round(nY),
  }
}

function autoClickAt(x, y, force = false) {
  if (!ENABLE_GHOST_AUTOMATION && !force) return
  if (process.platform !== 'win32') return
  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class NativeMouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
}
"@;
[NativeMouse]::SetCursorPos(${x}, ${y}) | Out-Null;
Start-Sleep -Milliseconds 70;
[NativeMouse]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero);
[NativeMouse]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero);
`
  execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], (err) => {
    if (err) console.warn('[ghost] auto-click failed:', err.message)
  })
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
    backgroundColor:    '#00000000',
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
    // Uncomment the line below to open DevTools for debugging:
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

// ── Ghost cursor overlay window ───────────────────────────────────────────────
let ghostHideTimer = null

function createGhostWindow() {
  // Small window — just big enough for the cursor SVG + pulse rings
  ghostWin = new BrowserWindow({
    width:           160,
    height:          160,
    x:               0,
    y:               0,
    transparent:     true,
    frame:           false,
    alwaysOnTop:     true,
    skipTaskbar:     true,
    focusable:       false,
    resizable:       false,
    show:            false,
    hasShadow:       false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
  })
  ghostWin.setIgnoreMouseEvents(true, { forward: true })
  ghostWin.setAlwaysOnTop(true, 'screen-saver', 2)
  ghostWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  if (isDev) {
    ghostWin.loadURL('http://localhost:5173/ghost-cursor')
  } else {
    ghostWin.loadFile(path.join(__dirname, '../frontend/dist/index.html'), { hash: '/ghost-cursor' })
  }

  ghostWin.on('closed', () => { ghostWin = null })
}

function hideGhostCursor() {
  if (ghostHideTimer) { clearTimeout(ghostHideTimer); ghostHideTimer = null }
  if (!ghostWin) return
  ghostWin.webContents.send('ghost-cursor-move', { x: -1, y: -1 })
  setTimeout(() => ghostWin?.hide(), 400)
}

// ── App ready ─────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  // Allow microphone access for audio recording (used for voice input)
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media' || permission === 'microphone') return callback(true)
    callback(false)
  })
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    if (permission === 'media' || permission === 'microphone') return true
    return false
  })

  createWindow()

  // ── IPC: collapse / expand ────────────────────────────────────────────────
  ipcMain.handle('toggle-collapse', () => {
    if (!win) return
    isCollapsed = !isCollapsed
    const targetH = isCollapsed ? COLLAPSED_H : WIDGET_HEIGHT
    win.setSize(WIDGET_WIDTH, targetH)
    return isCollapsed
  })

  ipcMain.handle('set-expanded', (_, expandedOrHeight) => {
    if (!win) return
    let targetH
    if (typeof expandedOrHeight === 'number') {
      // Frontend passed an explicit pixel height
      targetH = Math.max(COLLAPSED_H, Math.min(expandedOrHeight, 600))
    } else {
      targetH = expandedOrHeight ? WIDGET_HEIGHT : COLLAPSED_H
    }
    win.setSize(WIDGET_WIDTH, targetH)
  })

  ipcMain.handle('set-ignore-mouse', (_, ignore) => {
    win?.setIgnoreMouseEvents(ignore, { forward: true })
  })

  ipcMain.handle('get-collapsed', () => isCollapsed)

  // ── IPC: navigate overlay (StartPage → /overlay?session=…) ─────────────────
  ipcMain.handle('navigate-overlay', (_, route) => {
    if (!win) return false
    const r = typeof route === 'string' && route.startsWith('/') ? route : `/${route || ''}`
    if (isDev) {
      win.loadURL(`http://localhost:5173${r}`)
      return true
    }
    const clean = r.replace(/^\//, '')
    win.loadFile(path.join(__dirname, '../frontend/dist/index.html'), { hash: clean })
    return true
  })

  // ── IPC: step lifecycle ──────────────────────────────────────────────────
  ipcMain.handle('step-started', (_, stepIndex) => {
    currentStepIndex = stepIndex
    resetIdleTimer()
  })

  ipcMain.handle('session-ended', () => {
    currentStepIndex = -1
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
    hideGhostCursor()
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
  ipcMain.handle('analyze-screen', async (_, { screenshotBase64, stepIndex, instructionText, expectedScreen }) => {
    const body = JSON.stringify({
      screenshot_base64: screenshotBase64,
      step_index:        stepIndex,
      instruction_text:  instructionText,
      expected_screen:   expectedScreen || null,
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

  // ── IPC: ghost cursor ─────────────────────────────────────────────────────
  ipcMain.handle('show-ghost-cursor', (_, payload) => {
    const { x, y } = mapGhostTargetToScreen(payload?.x, payload?.y, Boolean(payload?.normalized))
    const shouldAutoClick = Boolean(payload?.autoClick)
    const forceAutoClick = Boolean(payload?.forceAutoClick)
    if (!ghostWin) createGhostWindow()
    // Move the small window to the target position (cursor tip at x,y)
    const show = () => {
      ghostWin?.setPosition(Math.round(x - 80), Math.round(y - 80), false)
      ghostWin?.webContents.send('ghost-cursor-move', { x: 80, y: 80 })  // local coords: center of window
      ghostWin?.show()
      if (shouldAutoClick) autoClickAt(x, y, forceAutoClick)
      if (ghostHideTimer) clearTimeout(ghostHideTimer)
      ghostHideTimer = setTimeout(hideGhostCursor, 3000)
    }
    if (ghostWin.webContents.isLoading()) {
      ghostWin.webContents.once('did-finish-load', show)
    } else {
      show()
    }
  })

  ipcMain.handle('hide-ghost-cursor', hideGhostCursor)

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
