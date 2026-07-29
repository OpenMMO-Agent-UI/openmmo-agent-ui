'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron')

const config = require('./config')
const { AgentProcess, candidateBinaries, resolveBinary, probeBinary } = require('./agent')
const { ClientServer, distReady } = require('./server')
const { AgentProxy } = require('./proxy')
const googleAuth = require('./googleAuth')
const characterSession = require('./characterSession')

const agent = new AgentProcess()
const clientServer = new ClientServer()
// Relay faults surface in the agent's own log pane: from the user's side the
// relay is part of "the agent", and a silent upstream failure reads as the
// game server hanging up for no reason.
const proxy = new AgentProxy(
  (message) => {
    console.error('[relay]', message)
    agent.append('app', `relay: ${message}`)
  },
  // What the character is wearing, which the agent's own panel API does not
  // publish — pushed as it changes rather than polled, since the relay learns
  // it the moment the server says so.
  (worn) => send('agent:worn', worn)
)
let feedTimer = null
let feedSeq = null
let settings = null
let win = null
// The pre-flight session (ADR 0001): open for the lifetime of the Character
// screen, closed once Play launches agent-client or the app signs out.
let preflightSession = null

function closePreflightSession() {
  if (preflightSession) preflightSession.close()
  preflightSession = null
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
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

/// A reply the agent cannot parse is dropped with a log line and no more:
/// no event, no error, no movement. That reads exactly like a healthy agent
/// standing still, and it once cost twenty minutes before anyone looked. The
/// feed carries the raw text, so judge it here and say so out loud.
let malformedRun = 0

function checkTurnShape(items) {
  for (const item of items) {
    if (item.k !== 'llm-response') continue
    const start = item.m.indexOf('{')
    const end = item.m.lastIndexOf('}')
    let ok = false
    if (start !== -1 && end > start) {
      try {
        ok = Array.isArray(JSON.parse(item.m.slice(start, end + 1)).actions)
      } catch {
        ok = false
      }
    }
    if (ok) {
      malformedRun = 0
      continue
    }
    malformedRun++
    // One is a hiccup the next turn covers; a run of them is the model
    // having drifted off the schema, and every one of those turns is lost.
    if (malformedRun === 3) {
      const message =
        `The model has answered ${malformedRun} times without a valid ` +
        `{thought, actions} object — those turns did nothing. Check the ` +
        `Thoughts tab; a bare action is the usual drift.`
      console.warn('[turns]', message)
      agent.append('app', message)
    }
  }
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
    checkTurnShape(items)
    send('agent:feed', items)
  }
  send('agent:vitals', {
    connected: body.connected === true,
    self: body.self || null,
    gold: body.gold ?? null,
    time: body.time || null,
    bag: body.bag || [],
  })
}

/// The spectator view is a full 3D client left running for hours, so its
/// renderer is the one process here that can grow without bound. Sample it
/// rather than wait for the OOM crash to explain itself.
const MEMORY_WARN_MB = 1500
let memoryTimer = null
let memoryWarned = false

function startMemoryWatch() {
  if (memoryTimer) return
  memoryTimer = setInterval(() => {
    const worst = app
      .getAppMetrics()
      .filter((m) => m.type === 'Tab' || m.type === 'Renderer')
      .sort((a, b) => (b.memory?.workingSetSize ?? 0) - (a.memory?.workingSetSize ?? 0))[0]
    const mb = Math.round((worst?.memory?.workingSetSize ?? 0) / 1024)
    send('view:memory', mb)
    if (mb > MEMORY_WARN_MB && !memoryWarned) {
      memoryWarned = true
      const message = `Spectator view is using ${mb} MB. Reload it from the header if it stalls.`
      console.warn('[memory]', message)
      agent.append('app', message)
    }
    if (mb < MEMORY_WARN_MB / 2) memoryWarned = false
  }, 30000)
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
/// agent's mirror socket instead of the game server. The only view there is,
/// so a failure here has nothing to fall back to and says so.
async function openSpectatorView() {
  try {
    const base = await clientServer.start(settings.terrain)
    const mirror = proxy.mirrorUrl
    if (!mirror) throw new Error('The relay is not listening yet.')
    send('view:ready', { scene: `${base}/?observe=${encodeURIComponent(mirror)}` })
  } catch (err) {
    send('view:error', err.message)
  }
}

app.whenReady().then(() => {
  config.seedRuntimeData()
  settings = config.importExistingConfig(config.load())
  config.save(settings)

  agent.on('log', (item) => send('agent:log', item))
  agent.on('state', (state) => {
    if (!state.running) stopFeedPolling()
    send('agent:state', state)
  })
  agent.on('fatal', (message) => send('agent:fatal', message))
  agent.on('watch-ready', (url) => {
    send('watch:ready', url)
    startFeedPolling(settings.watchPort)
    void openSpectatorView()
  })

  startMemoryWatch()
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
  // The pre-flight session already resolved the exact character agent-client
  // is about to enter with (ADR 0001) — nothing left for it to do.
  closePreflightSession()
  // agent-client hard-errors on a configured prompt file that doesn't exist —
  // guarantee both before every start, not just when the player opens the
  // personality-prompt editor.
  config.ensureUserPrompt()
  if (settings.characterName) config.ensureInstancePrompt(settings.characterName)
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

/// The personality prompt — the only prompt editor in the app. Per-character
/// (ADR: see config.js's instancePromptPath), layered on top of the fixed
/// general persona in user_prompt.txt, since it's meant to be individual, not
/// shared across the account's 3 characters.
ipcMain.handle('instance:get', (_e, characterName) => {
  if (!characterName) return ''
  try {
    return fs.readFileSync(config.instancePromptPath(characterName), 'utf8')
  } catch {
    return ''
  }
})

ipcMain.handle('instance:save', (_e, characterName, text) => {
  const file = config.instancePromptPath(characterName)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
  return { ok: true, file }
})

/// Signing out has to take the agent with it: it holds a live session on the
/// credential we are about to delete.
ipcMain.handle('auth:signout', async () => {
  const wasRunning = agent.running
  if (wasRunning) await agent.stopAndWait()
  closePreflightSession()
  const removed = config.signOut()
  // A new sign-in may be a different account; last session's chosen
  // character shouldn't carry over silently.
  settings = config.save({ ...settings, characterName: '' })
  return { removed, wasRunning, signedIn: config.signedIn() }
})

/// Cheap, no-network check: is there a cached Google credential for the
/// currently configured client? Drives the Login screen's initial
/// Continue-vs-sign-in state (ADR 0001).
ipcMain.handle('auth:status', () => ({
  signedIn: Boolean(googleAuth.cachedRefreshToken(settings.googleClientId)),
}))

/// Mints a fresh id_token from a refresh token and (re)opens the pre-flight
/// session on it, replacing whatever was open before. Returns the id_token
/// since finishSignIn() below still needs it for peekEmail().
async function reopenPreflightSession(refreshToken) {
  const idToken = await googleAuth.mintIdToken(refreshToken, settings.googleClientId, settings.googleClientSecret)
  closePreflightSession()
  preflightSession = await characterSession.openSession(settings.server, idToken)
  return idToken
}

/// Shared tail of both sign-in paths below.
async function finishSignIn(refreshToken) {
  const idToken = await reopenPreflightSession(refreshToken)
  return {
    ok: true,
    email: googleAuth.peekEmail(idToken),
    accountName: preflightSession.accountName,
    characters: preflightSession.characters,
  }
}

/// Play closes the pre-flight session once agent-client takes over (see
/// startAgent()) — but Stop, or the agent simply exiting, bounces the
/// renderer straight back to the Character screen, whose create/delete
/// still need a live session. Re-derive one from the cached credential
/// alone rather than failing outright; never runs a new device flow, so a
/// truly expired sign-in still reports "Not signed in" instead of silently
/// prompting in the background.
async function ensurePreflightSession() {
  if (preflightSession) return { ok: true }
  const refreshToken = googleAuth.cachedRefreshToken(settings.googleClientId)
  if (!refreshToken) return { ok: false, error: 'Not signed in' }
  try {
    await reopenPreflightSession(refreshToken)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

function signInError(err) {
  const isProtocolMismatch = err instanceof characterSession.ProtocolMismatchError
  return { ok: false, protocolMismatch: isProtocolMismatch, error: err.message }
}

/// A cached credential already exists — mint a fresh id_token from it and go
/// straight to listing characters, no device flow shown.
ipcMain.handle('auth:continue', async () => {
  try {
    const refreshToken = googleAuth.cachedRefreshToken(settings.googleClientId)
    if (!refreshToken) throw new Error('No cached credential to continue with')
    return await finishSignIn(refreshToken)
  } catch (err) {
    return signInError(err)
  }
})

/// No cached credential: run the device flow, surfacing the url/code as soon
/// as Google issues them (agent:device-code carries them to the Login
/// screen), then continue exactly as `auth:continue` does.
ipcMain.handle('auth:signin', async () => {
  try {
    const refreshToken = await googleAuth.runDeviceFlow(
      settings.googleClientId,
      settings.googleClientSecret,
      (code) => send('auth:device-code', code),
    )
    return await finishSignIn(refreshToken)
  } catch (err) {
    return signInError(err)
  }
})

ipcMain.handle('characters:create', async (_e, { name, characterClass, gender }) => {
  const ready = await ensurePreflightSession()
  if (!ready.ok) return ready
  try {
    return { ok: true, character: await preflightSession.createCharacter(name, characterClass, gender) }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('characters:delete', async (_e, characterId) => {
  const ready = await ensurePreflightSession()
  if (!ready.ok) return ready
  try {
    await preflightSession.deleteCharacter(characterId)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

/// A directive (ADR 0003): best-effort, delivered as a relay-forged whisper.
/// Only meaningful once agent-client is actually running and connected.
ipcMain.handle('directive:send', (_e, text) => {
  if (!agent.running) return { ok: false, error: 'Not running' }
  const delivered = proxy.sendDirective(settings.characterName, text)
  if (!delivered) return { ok: false, error: 'Not connected yet — try again in a moment' }
  return { ok: true }
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

/// Confirms the OS can actually exec the resolved binary — catches a picked
/// .app bundle, wrong-arch build, or corrupted download before Play does,
/// which otherwise surfaces as a bare "spawn ENOEXEC" deep in the log.
ipcMain.handle('binary:check', async () => {
  const binary = resolveBinary(settings.binaryPath)
  if (!binary) return { ok: false, error: 'No agent-client binary found. Build it or choose one.' }
  const probe = await probeBinary(binary)
  return { ...probe, path: binary }
})

/// Re-hand the renderer the scene URL. `view:ready` is pushed once, when the
/// agent's watch server comes up — but a window closed and reopened on macOS
/// boots a fresh renderer with nothing to show, and the session it belongs to
/// is still playing. So the panel asks for it on load.
ipcMain.handle('view:open', async () => {
  if (!agent.running) return { ok: false }
  await openSpectatorView()
  return { ok: true }
})

ipcMain.handle('shell:open', (_e, target) => {
  // A button whose target has not been filled in yet must do nothing, not
  // throw an unhandled rejection into the renderer.
  if (typeof target !== 'string' || !target) return { ok: false }
  if (/^https?:\/\//.test(target)) shell.openExternal(target)
  else shell.openPath(target)
  return { ok: true }
})
