'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron')

const config = require('./config')
const { AgentProcess, candidateBinaries, resolveBinary } = require('./agent')
const { ClientServer, distReady } = require('./server')
const { AgentProxy } = require('./proxy')

const agent = new AgentProcess()
const clientServer = new ClientServer()
// Relay faults surface in the agent's own log pane: from the user's side the
// relay is part of "the agent", and a silent upstream failure reads as the
// game server hanging up for no reason.
const proxy = new AgentProxy((message) => {
  console.error('[relay]', message)
  agent.append('app', `relay: ${message}`)
})
let feedTimer = null
let feedSeq = null
let settings = null
let win = null

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

function promptPaths() {
  const data = path.join(config.agentDir(), 'data')
  return {
    user: path.join(data, 'user_prompt.txt'),
    presets: path.join(data, 'user_prompts'),
    system: path.join(data, 'system_prompt.txt'),
  }
}

function readPrompt() {
  const p = promptPaths()
  let presets = []
  try {
    presets = fs
      .readdirSync(p.presets)
      .filter((f) => f.endsWith('.txt'))
      .map((f) => f.replace(/\.txt$/, ''))
  } catch {
    presets = []
  }

  let text = ''
  try {
    text = fs.readFileSync(p.user, 'utf8')
  } catch {
    // No user prompt yet: agent-client falls back to newcomer, so show that.
    try {
      text = fs.readFileSync(path.join(p.presets, 'newcomer.txt'), 'utf8')
    } catch {
      text = ''
    }
  }
  return { text, presets, file: p.user }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1080,
    minHeight: 680,
    backgroundColor: '#12141a',
    title: 'OpenMMO Agent',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  // Renderer faults are invisible in a packaged app; surface them on stderr.
  win.webContents.on('console-message', (...args) => {
    const details = typeof args[0] === 'object' && args[0].message ? args[0] : { level: args[1], message: args[2] }
    if (details.level === 'error' || details.level === 3) console.error('[renderer]', details.message)
  })
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    // -3 (ABORTED) on a subframe is the iframe being cleared, which is normal.
    if (code === -3 && !isMainFrame) return
    console.error('[renderer] load failed', code, desc, url, isMainFrame ? '(main frame)' : '(subframe)')
  })

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
}

/// Poll the agent's own panel API for the LLM feed and vitals. Done here
/// rather than in the renderer because that page is file:// and the panel
/// sends no CORS headers.
async function pollFeed(port) {
  const since = feedSeq === null ? '' : `?since=${feedSeq}`
  const res = await fetch(`http://127.0.0.1:${port}/api/state${since}`, {
    signal: AbortSignal.timeout(4000),
  })
  if (!res.ok) return
  const body = await res.json()
  const items = body.feed || []
  if (items.length) {
    feedSeq = items[items.length - 1].s
    send('agent:feed', items)
  }
  send('agent:vitals', {
    connected: body.connected === true,
    self: body.self || null,
    gold: body.gold ?? null,
    time: body.time || null,
  })
}

function startFeedPolling(port) {
  stopFeedPolling()
  if (!port) return
  feedSeq = null
  feedTimer = setInterval(() => {
    pollFeed(port).catch(() => {})
  }, 1000)
}

function stopFeedPolling() {
  if (feedTimer) clearInterval(feedTimer)
  feedTimer = null
}

/// The spectator view: the built web client, served locally, pointed at the
/// agent's mirror socket instead of the game server.
async function openSpectatorView() {
  try {
    const base = await clientServer.start(settings.terrain)
    const mirror = proxy.mirrorUrl
    if (!mirror) throw new Error('The relay is not listening yet.')
    send('view:ready', {
      scene: `${base}/?observe=${encodeURIComponent(mirror)}`,
      panel: `http://127.0.0.1:${settings.watchPort}/`,
    })
  } catch (err) {
    send('view:error', err.message)
  }
}

app.whenReady().then(() => {
  settings = config.importExistingConfig(config.load())
  config.save(settings)

  agent.on('log', (item) => send('agent:log', item))
  agent.on('state', (state) => {
    if (!state.running) stopFeedPolling()
    send('agent:state', state)
  })
  agent.on('device-code', (code) => send('agent:device-code', code))
  agent.on('watch-ready', (url) => {
    send('watch:ready', url)
    startFeedPolling(settings.watchPort)
    void openSpectatorView()
  })

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  agent.stop()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  stopFeedPolling()
  clientServer.stop()
  proxy.stop()
  agent.stop()
})

ipcMain.handle('app:info', () => ({
  settings,
  backends: config.BACKENDS,
  classes: config.CLASSES,
  agentDir: config.agentDir(),
  binary: resolveBinary(settings.binaryPath) || null,
  searched: candidateBinaries(settings.binaryPath),
  status: agent.status(),
  log: agent.log,
  clientBuilt: distReady(),
  signedIn: config.signedIn(),
  credentialPath: config.credentialPath(),
}))

ipcMain.handle('settings:save', (_e, patch) => {
  settings = config.save({ ...settings, ...patch, models: { ...settings.models, ...(patch.models || {}) } })
  return settings
})

ipcMain.handle('settings:validate', (_e, patch) => config.validate({ ...settings, ...patch }))

ipcMain.handle('config:preview', () => config.renderConfigToml(settings))

/// agent-client talks to our loopback relay; the relay holds the only
/// connection to the real server. `settings.server` stays the upstream URL —
/// it is what the user configured and what the relay dials.
async function startAgent() {
  const errors = config.validate(settings)
  if (errors.length) return { ok: false, errors }
  try {
    await proxy.start(settings.server)
    return { ok: true, status: await agent.start({ ...settings, server: proxy.agentUrl }) }
  } catch (err) {
    return { ok: false, errors: [err.message] }
  }
}

ipcMain.handle('agent:start', startAgent)

ipcMain.handle('agent:stop', () => ({ ok: true, status: agent.stop() }))

ipcMain.handle('agent:restart', async () => {
  if (agent.running) await agent.stopAndWait()
  return startAgent()
})

ipcMain.handle('prompt:get', () => readPrompt())

ipcMain.handle('prompt:save', (_e, text) => {
  const p = promptPaths()
  fs.mkdirSync(path.dirname(p.user), { recursive: true })
  fs.writeFileSync(p.user, text)
  return { ok: true, file: p.user }
})

ipcMain.handle('prompt:preset', (_e, name) => {
  const file = path.join(promptPaths().presets, `${name}.txt`)
  try {
    return { ok: true, text: fs.readFileSync(file, 'utf8') }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('prompt:system', () => {
  try {
    return fs.readFileSync(promptPaths().system, 'utf8')
  } catch (err) {
    return `(unreadable: ${err.message})`
  }
})

/// Signing out has to take the agent with it: it holds a live session on the
/// credential we are about to delete.
ipcMain.handle('auth:signout', async () => {
  const wasRunning = agent.running
  if (wasRunning) await agent.stopAndWait()
  const removed = config.signOut()
  return { removed, wasRunning, signedIn: config.signedIn() }
})

ipcMain.handle('binary:pick', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Select the agent-client binary',
    properties: ['openFile'],
  })
  if (res.canceled || !res.filePaths[0]) return null
  settings = config.save({ ...settings, binaryPath: res.filePaths[0] })
  return settings.binaryPath
})

ipcMain.handle('shell:open', (_e, target) => {
  // A button whose target has not been filled in yet must do nothing, not
  // throw an unhandled rejection into the renderer.
  if (typeof target !== 'string' || !target) return { ok: false }
  if (/^https?:\/\//.test(target)) shell.openExternal(target)
  else shell.openPath(target)
  return { ok: true }
})
