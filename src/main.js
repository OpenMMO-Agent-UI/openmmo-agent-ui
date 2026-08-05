'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { app, BrowserWindow, ipcMain, safeStorage, shell } = require('electron')

const config = require('./config')
const { AgentProcess } = require('./agent')
const { ClientServer, distReady } = require('./server')
const { AgentProxy } = require('./proxy')
const googleAuth = require('./googleAuth')
const characterSession = require('./characterSession')
const { ConnectionProfileStore } = require('./connectionProfiles')
const { CharacterStore } = require('./characterStore')
const { PlaySessionCoordinator } = require('./playSession')
const { validateLlmSettings } = require('./llmValidation')

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
let profileStore = null
let characterStore = null
let currentIdToken = null
let playSession = null
let currentCharacters = []
let activeCharacterId = null
let manualReadiness = null
let authGeneration = 0
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
// Actions from the most recently *valid* llm-response, shown next to the
// clock in the gamebar header. Cleared on a malformed turn rather than left
// stale, since a bad turn did nothing.
let lastActions = null

function checkTurnShape(items) {
  for (const item of items) {
    if (item.k !== 'llm-response') continue
    const start = item.m.indexOf('{')
    const end = item.m.lastIndexOf('}')
    let actions = null
    if (start !== -1 && end > start) {
      try {
        const parsed = JSON.parse(item.m.slice(start, end + 1))
        if (Array.isArray(parsed.actions)) actions = parsed.actions
      } catch {
        actions = null
      }
    }
    if (actions) {
      malformedRun = 0
      lastActions = actions
      continue
    }
    lastActions = null
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
    actions: lastActions,
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
  lastActions = null
  feedTimer = setInterval(() => {
    pollFeed(port).catch(() => {})
  }, 1000)
}

function stopFeedPolling() {
  if (feedTimer) clearInterval(feedTimer)
  feedTimer = null
}

/// The spectator view's URL: the built web client, served locally, pointed at
/// the agent's mirror socket instead of the game server — never the agent's
/// own raw watch-panel port, which speaks a JSON API, not the game UI.
async function spectatorSceneUrl() {
  const base = await clientServer.start(settings.terrain)
  const mirror = proxy.mirrorUrl
  if (!mirror) throw new Error('The relay is not listening yet.')
  return `${base}/?observe=${encodeURIComponent(mirror)}`
}

/// The only view there is, so a failure here has nothing to fall back to and
/// says so.
async function openSpectatorView() {
  try {
    send('view:ready', { scene: await spectatorSceneUrl() })
  } catch (err) {
    send('view:error', err.message)
  }
}

function profileCipher() {
  const keyFile = path.join(app.getPath('userData'), 'profile-secrets.key')
  const fallbackKey = () => {
    if (!fs.existsSync(keyFile)) {
      fs.mkdirSync(path.dirname(keyFile), { recursive: true })
      fs.writeFileSync(keyFile, crypto.randomBytes(32), { mode: 0o600 })
    }
    return fs.readFileSync(keyFile)
  }
  return {
    encrypt(value) {
      const json = JSON.stringify(value)
      if (safeStorage.isEncryptionAvailable()) {
        return `enc:${safeStorage.encryptString(json).toString('base64')}`
      }
      const iv = crypto.randomBytes(12)
      const cipher = crypto.createCipheriv('aes-256-gcm', fallbackKey(), iv)
      const encrypted = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()])
      return `aes:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${encrypted.toString('base64')}`
    },
    decrypt(value) {
      if (value.startsWith('enc:') && safeStorage.isEncryptionAvailable()) {
        return JSON.parse(safeStorage.decryptString(Buffer.from(value.slice(4), 'base64')))
      }
      if (value.startsWith('plain:')) {
        return JSON.parse(Buffer.from(value.slice(6), 'base64').toString('utf8'))
      }
      if (value.startsWith('aes:')) {
        const [, iv, tag, encrypted] = value.split(':')
        const decipher = crypto.createDecipheriv(
          'aes-256-gcm',
          fallbackKey(),
          Buffer.from(iv, 'base64'),
        )
        decipher.setAuthTag(Buffer.from(tag, 'base64'))
        return JSON.parse(
          Buffer.concat([
            decipher.update(Buffer.from(encrypted, 'base64')),
            decipher.final(),
          ]).toString('utf8'),
        )
      }
      throw new Error('Connection-profile secrets cannot be decrypted')
    },
  }
}

function selectedProfileSettings() {
  return profileStore.withSecrets(profileStore.selected().id)
}

function applySelectedProfile() {
  const profile = selectedProfileSettings()
  settings = config.save({
    ...settings,
    server: profile.serverUrl,
    terrain: profile.terrainOrigin,
    authMode: 'google',
    googleClientId: profile.googleClientId,
    googleClientSecret: profile.googleClientSecret,
  })
  const refreshToken = profileStore.credential(profile.id)
  if (refreshToken) googleAuth.writeCache(profile.googleClientId, refreshToken)
  else googleAuth.clearCache()
  return profile
}

function validateGlobalLlm() {
  const backend = config.BACKENDS.find((candidate) => candidate.id === settings.llm)
  if (!backend || backend.kind === 'none') {
    return { ok: false, error: 'Set up an LLM to use Automatic play' }
  }
  if (backend.kind === 'http' && !settings.models[settings.llm]) {
    return { ok: false, error: `Pick a model for ${backend.label}` }
  }
  if (settings.llm === 'openrouter' && !settings.openrouterKey) {
    return { ok: false, error: 'OpenRouter needs an API key' }
  }
  if (settings.llm === 'openai' && (!settings.openaiBaseUrl || !settings.openaiKey)) {
    return { ok: false, error: 'OpenAI-compatible mode needs a Base URL and API key' }
  }
  return { ok: true }
}

async function stopAiController() {
  if (agent.running) await agent.stopAndWait()
  stopFeedPolling()
  proxy.stop()
  send('view:stop')
}

function waitForAgentWorld() {
  let cancel
  const promise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('AI did not enter the world in time')), 30000)
    const ready = (url) => finish(null, url)
    const fatal = (message) => finish(new Error(message))
    const state = (next) => {
      if (!next.running && next.exitCode != null) finish(new Error('AI exited before entering the world'))
    }
    function finish(error, url) {
      clearTimeout(timeout)
      agent.off('watch-ready', ready)
      agent.off('fatal', fatal)
      agent.off('state', state)
      if (error) reject(error)
      else resolve(url)
    }
    agent.once('watch-ready', ready)
    agent.once('fatal', fatal)
    agent.on('state', state)
    cancel = () => finish(new Error('AI startup canceled'))
  })
  promise.cancel = cancel
  return promise
}

async function startManualController(context) {
  closePreflightSession()
  const profile = selectedProfileSettings()
  const refreshToken = profileStore.credential(profile.id)
  if (!refreshToken) throw new Error('Not signed in')
  currentIdToken = await googleAuth.mintIdToken(
    refreshToken,
    profile.googleClientId,
    profile.googleClientSecret,
  )
  const base = await clientServer.start(profile.terrainOrigin)
  const bootstrap = Buffer.from(
    JSON.stringify({
      serverUrl: profile.serverUrl,
      googleIdToken: currentIdToken,
      characterId: context.characterId,
    }),
  ).toString('base64url')
  const viewUrl = `${base}/#manual=${bootstrap}`
  const readiness = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      manualReadiness = null
      reject(new Error('Manual client did not enter the world in time'))
    }, 30000)
    manualReadiness = {
      finish(error) {
        clearTimeout(timeout)
        manualReadiness = null
        if (error) reject(new Error(error))
        else resolve()
      },
    }
  })
  send('view:ready', { scene: viewUrl, mode: 'manual' })
  await readiness
  return { viewUrl }
}

async function stopManualController() {
  manualReadiness?.finish('Manual startup canceled')
  send('view:stop')
}

function createPlaySession() {
  return new PlaySessionCoordinator({
    ai: {
      start: async () => {
        const ready = waitForAgentWorld()
        ready.catch(() => {})
        const result = await startAgent()
        if (!result.ok) {
          ready.cancel()
          throw new Error(result.errors.join('\n'))
        }
        // `ready` only signals that the agent's watch panel is up — its
        // resolved value is that panel's own raw URL, not a place to point
        // the spectator iframe at.
        await ready
        return { viewUrl: await spectatorSceneUrl() }
      },
      stop: stopAiController,
      cancelPending: async () => {},
    },
    manual: {
      start: startManualController,
      stop: stopManualController,
    },
    validateLlm: async () => validateGlobalLlm(),
    scheduler: {
      schedule(fn, delayMs) {
        const timer = setTimeout(fn, delayMs)
        return () => clearTimeout(timer)
      },
    },
    onState: (state) => send('play:state', state),
  })
}

app.whenReady().then(() => {
  config.seedRuntimeData()
  settings = config.importExistingConfig(config.load())
  config.save(settings)
  const legacyRefreshToken = googleAuth.cachedRefreshToken(settings.googleClientId)
  profileStore = new ConnectionProfileStore({
    file: path.join(app.getPath('userData'), 'connection-profiles.json'),
    cipher: profileCipher(),
    builtin: {
      name: 'openmmo.to.nexus',
      serverUrl: config.DEFAULTS.server,
      terrainOrigin: config.DEFAULTS.terrain,
      googleClientId: config.DEFAULTS.googleClientId,
      googleClientSecret: config.DEFAULTS.googleClientSecret || '',
    },
    legacy: {
      server: settings.server,
      terrain: settings.terrain,
      googleClientId: settings.googleClientId,
      googleClientSecret: settings.googleClientSecret,
      refreshToken: legacyRefreshToken,
      characterId: null,
      account: null,
    },
  })
  characterStore = new CharacterStore({ baseDir: app.getPath('userData') })
  applySelectedProfile()
  playSession = createPlaySession()

  agent.on('log', (item) => send('agent:log', item))
  agent.on('state', (state) => {
    if (!state.running) stopFeedPolling()
    send('agent:state', state)
    if (!state.running && state.exitCode != null) playSession?.controllerExited('AI disconnected')
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
  void playSession?.stop()
  app.quit()
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
  status: agent.status(),
  log: agent.log,
  clientBuilt: distReady(),
  signedIn: config.signedIn(),
  credentialPath: config.credentialPath(),
}))

ipcMain.handle('profiles:list', () => profileStore.list())

ipcMain.handle('profiles:create', (_e, input) => profileStore.create(input))

ipcMain.handle('profiles:update', (_e, id, patch) => profileStore.update(id, patch))

ipcMain.handle('profiles:duplicate', (_e, id) => profileStore.duplicate(id))

ipcMain.handle('profiles:delete', (_e, id) => {
  profileStore.delete(id)
  return profileStore.list()
})

ipcMain.handle('profiles:select', (_e, id) => {
  authGeneration++
  closePreflightSession()
  currentCharacters = []
  profileStore.select(id)
  return applySelectedProfile()
})

ipcMain.handle('profiles:test', async (_e, id) => {
  const profile = profileStore.withSecrets(id)
  if (!profile) return { ok: false, error: 'Connection profile not found' }
  try {
    await characterSession.testConnection(profile.serverUrl, profile.terrainOrigin)
    profileStore.setValidation(id, { ok: true, checkedAt: Date.now() })
    return { ok: true }
  } catch (err) {
    profileStore.setValidation(id, { ok: false, checkedAt: Date.now(), error: err.message })
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('settings:save', (_e, patch) => {
  settings = config.save({ ...settings, ...patch, models: { ...settings.models, ...(patch.models || {}) } })
  return settings
})

ipcMain.handle('settings:validate', (_e, patch) => config.validate({ ...settings, ...patch }))

ipcMain.handle('settings:apply', async (_e, patch) => {
  const candidate = {
    ...settings,
    ...patch,
    models: { ...settings.models, ...(patch.models || {}) },
  }
  const errors = config.validate(candidate)
  if (errors.length) return { ok: false, errors }
  const live = await validateLlmSettings(candidate)
  if (!live.ok) return { ok: false, errors: [live.error] }
  settings = config.save(candidate)
  return { ok: true, settings }
})

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
  currentCharacters = []
  // agent-client hard-errors on a configured prompt file that doesn't exist —
  // guarantee both before every start, not just when the player opens the
  // personality-prompt editor.
  config.ensureUserPrompt()
  if (settings.characterName) {
    materializePersonality(profileStore.selected().id, activeCharacterId, settings.characterName)
    config.ensureInstancePrompt(settings.characterName)
  }
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

function personalityPath(profileId, characterId) {
  const safe = (value) => String(value || '').replace(/[^a-zA-Z0-9_-]/g, '_')
  return path.join(app.getPath('userData'), 'personalities', safe(profileId), `${safe(characterId)}.txt`)
}

function materializePersonality(profileId, characterId, characterName) {
  if (!characterName) return
  const scoped = characterId ? personalityPath(profileId, characterId) : null
  const legacy = config.instancePromptPath(characterName)
  if (scoped && !fs.existsSync(scoped) && fs.existsSync(legacy)) {
    fs.mkdirSync(path.dirname(scoped), { recursive: true })
    fs.copyFileSync(legacy, scoped)
  }
  if (scoped && fs.existsSync(scoped)) {
    fs.mkdirSync(path.dirname(legacy), { recursive: true })
    fs.copyFileSync(scoped, legacy)
  }
}

/// Personality is isolated by connection profile and stable character ID.
/// The name-based agent path is only a materialized compatibility copy. The
/// file on disk also carries an app-managed sellable/dropable block (see
/// config.composeInstanceText) that the textarea must never show or let the
/// player accidentally overwrite — stripped here before it reaches the
/// renderer.
ipcMain.handle('instance:get', (_e, { characterId, characterName }) => {
  if (!characterId) return ''
  const file = personalityPath(profileStore.selected().id, characterId)
  try {
    if (!fs.existsSync(file)) materializePersonality(profileStore.selected().id, characterId, characterName)
    return config.splitInstanceText(fs.readFileSync(file, 'utf8')).prose
  } catch {
    return ''
  }
})

ipcMain.handle('instance:save', (_e, { characterId, characterName, text }) => {
  if (!characterId) return { ok: false, error: 'No character selected' }
  const profileId = profileStore.selected().id
  const file = personalityPath(profileId, characterId)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    config.composeInstanceText(text, characterStore.open('labels', profileId, characterId).read())
  )
  if (characterName) materializePersonality(profileId, characterId, characterName)
  return { ok: true, file }
})

/// Read-only view of what the agent itself has written to memory.txt (its
/// own `memory_update` output, never edited by the player) — see
/// config.memoryPath. Missing file (nothing remembered yet, or the agent has
/// never run) just reads as empty.
ipcMain.handle('memory:get', (_e, { characterName }) => {
  if (!characterName) return ''
  try {
    return fs.readFileSync(config.memoryPath(characterName), 'utf8')
  } catch {
    return ''
  }
})

/// Sellable/dropable marks on bag items — the source of truth for the bag
/// drawer's checkboxes; instance.txt's own copy (below) is just a rendering
/// of this for agent-client to read.
ipcMain.handle('labels:get', (_e, { characterId }) => {
  if (!characterId) return { sellable: [], dropable: [] }
  return characterStore.open('labels', profileStore.selected().id, characterId).read()
})

ipcMain.handle('labels:save', (_e, { characterId, characterName, labels }) => {
  if (!characterId) return { ok: false, error: 'No character selected' }
  const profileId = profileStore.selected().id
  const clean = {
    sellable: Array.isArray(labels?.sellable) ? [...new Set(labels.sellable)] : [],
    dropable: Array.isArray(labels?.dropable) ? [...new Set(labels.dropable)] : [],
  }
  characterStore.open('labels', profileId, characterId).write(clean)
  // Re-render instance.txt's labels block from the character's existing
  // prose plus these new marks — mirrors instance:save, just triggered by a
  // label change instead of a personality edit.
  const file = personalityPath(profileId, characterId)
  let prose = ''
  try {
    prose = config.splitInstanceText(fs.readFileSync(file, 'utf8')).prose
  } catch {
    prose = ''
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, config.composeInstanceText(prose, clean))
  if (characterName) materializePersonality(profileId, characterId, characterName)
  return { ok: true, labels: clean }
})

/// Player-saved coordinates, isolated by connection profile and character.
ipcMain.handle('coordinates:list', (_e, { characterId }) => {
  if (!characterId) return []
  return characterStore.open('coordinates', profileStore.selected().id, characterId).read()
})

ipcMain.handle('coordinates:add', (_e, { characterId, name, x, y, z }) => {
  if (!characterId) return { ok: false, error: 'No character selected' }
  const { read, write } = characterStore.open('coordinates', profileStore.selected().id, characterId)
  const list = read()
  list.push({ id: crypto.randomUUID(), name, x, y, z })
  write(list)
  return { ok: true, list }
})

ipcMain.handle('coordinates:delete', (_e, { characterId, id }) => {
  if (!characterId) return { ok: false, error: 'No character selected' }
  const { read, write } = characterStore.open('coordinates', profileStore.selected().id, characterId)
  const list = read().filter((c) => c.id !== id)
  write(list)
  return { ok: true, list }
})

/// Player-saved dispatch presets, same scoping/shape as coordinates.
ipcMain.handle('presets:list', (_e, { characterId }) => {
  if (!characterId) return []
  return characterStore.open('presets', profileStore.selected().id, characterId).read()
})

ipcMain.handle('presets:add', (_e, { characterId, name, prompt }) => {
  if (!characterId) return { ok: false, error: 'No character selected' }
  const { read, write } = characterStore.open('presets', profileStore.selected().id, characterId)
  const list = read()
  list.push({ id: crypto.randomUUID(), name, prompt })
  write(list)
  return { ok: true, list }
})

ipcMain.handle('presets:update', (_e, { characterId, id, name, prompt }) => {
  if (!characterId) return { ok: false, error: 'No character selected' }
  const { read, write } = characterStore.open('presets', profileStore.selected().id, characterId)
  const list = read()
  const preset = list.find((p) => p.id === id)
  if (!preset) return { ok: false, error: 'Preset not found' }
  preset.name = name
  preset.prompt = prompt
  write(list)
  return { ok: true, list }
})

ipcMain.handle('presets:delete', (_e, { characterId, id }) => {
  if (!characterId) return { ok: false, error: 'No character selected' }
  const { read, write } = characterStore.open('presets', profileStore.selected().id, characterId)
  const list = read().filter((p) => p.id !== id)
  write(list)
  return { ok: true, list }
})

/// Signing out has to take the agent with it: it holds a live session on the
/// credential we are about to delete.
ipcMain.handle('auth:signout', async () => {
  authGeneration++
  const wasRunning = agent.running
  if (wasRunning) await agent.stopAndWait()
  closePreflightSession()
  const profileId = profileStore.selected().id
  const removed = Boolean(profileStore.credential(profileId))
  profileStore.setCredential(profileId, null)
  googleAuth.clearCache()
  currentCharacters = []
  currentIdToken = null
  // A new sign-in may be a different account; last session's chosen
  // character shouldn't carry over silently.
  settings = config.save({ ...settings, characterName: '' })
  return { removed, wasRunning, signedIn: config.signedIn() }
})

/// Cheap, no-network check: is there a cached Google credential for the
/// currently configured client? Drives the Login screen's initial
/// Continue-vs-sign-in state (ADR 0001).
ipcMain.handle('auth:status', () => ({
  signedIn: Boolean(profileStore.credential(profileStore.selected().id)),
}))

/// Mints a fresh id_token from a refresh token and (re)opens the pre-flight
/// session on it, replacing whatever was open before. Returns the id_token
/// since finishSignIn() below still needs it for peekEmail().
async function reopenPreflightSession(refreshToken, profile = selectedProfileSettings()) {
  const idToken = await googleAuth.mintIdToken(
    refreshToken,
    profile.googleClientId,
    profile.googleClientSecret,
  )
  closePreflightSession()
  preflightSession = await characterSession.openSession(profile.serverUrl, idToken)
  return idToken
}

/// Shared tail of both sign-in paths below.
async function finishSignIn(refreshToken, profileId, generation) {
  const profile = profileStore.withSecrets(profileId)
  if (!profile) throw new Error('Connection profile no longer exists')
  const idToken = await googleAuth.mintIdToken(
    refreshToken,
    profile.googleClientId,
    profile.googleClientSecret,
  )
  const session = await characterSession.openSession(profile.serverUrl, idToken)
  if (generation !== authGeneration || profileStore.selected().id !== profileId) {
    session.close()
    return { ok: false, canceled: true, error: 'Sign-in canceled' }
  }
  closePreflightSession()
  preflightSession = session
  currentIdToken = idToken
  currentCharacters = preflightSession.characters
  profileStore.setCredential(profileId, refreshToken)
  googleAuth.writeCache(profile.googleClientId, refreshToken)
  profileStore.rememberSession(profileId, {
    account: googleAuth.peekEmail(idToken),
    characterId: profileStore.get(profileId).lastSession?.characterId ?? null,
  })
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
  const refreshToken = profileStore.credential(profileStore.selected().id)
  if (!refreshToken) return { ok: false, error: 'Not signed in' }
  try {
    await reopenPreflightSession(refreshToken)
    currentCharacters = preflightSession.characters
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
    const profileId = profileStore.selected().id
    const generation = ++authGeneration
    const refreshToken = profileStore.credential(profileId)
    if (!refreshToken) throw new Error('No cached credential to continue with')
    return await finishSignIn(refreshToken, profileId, generation)
  } catch (err) {
    return signInError(err)
  }
})

/// No cached credential: run the device flow, surfacing the url/code as soon
/// as Google issues them (agent:device-code carries them to the Login
/// screen), then continue exactly as `auth:continue` does.
ipcMain.handle('auth:signin', async () => {
  try {
    const profileId = profileStore.selected().id
    const profile = profileStore.withSecrets(profileId)
    const generation = ++authGeneration
    const refreshToken = await googleAuth.runDeviceFlow(
      profile.googleClientId,
      profile.googleClientSecret,
      (code) => send('auth:device-code', code),
    )
    return await finishSignIn(refreshToken, profileId, generation)
  } catch (err) {
    return signInError(err)
  }
})

ipcMain.handle('auth:cancel', () => {
  authGeneration++
  closePreflightSession()
  return { ok: true }
})

ipcMain.handle('characters:create', async (_e, { name, characterClass, gender }) => {
  const ready = await ensurePreflightSession()
  if (!ready.ok) return ready
  try {
    const character = await preflightSession.createCharacter(name, characterClass, gender)
    currentCharacters.push(character)
    return { ok: true, character }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('characters:delete', async (_e, characterId) => {
  const ready = await ensurePreflightSession()
  if (!ready.ok) return ready
  try {
    await preflightSession.deleteCharacter(characterId)
    currentCharacters = currentCharacters.filter((character) => character.id !== characterId)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('play:enter', async (_e, characterId) => {
  const ready = await ensurePreflightSession()
  if (!ready.ok) return ready
  const character = currentCharacters.find((candidate) => candidate.id === characterId)
  if (!character) return { ok: false, error: 'That character is no longer in this account roster' }
  const characterName = character.name
  settings = config.save({ ...settings, characterName })
  activeCharacterId = characterId
  profileStore.rememberSession(profileStore.selected().id, {
    account: profileStore.selected().lastSession?.account || null,
    characterId,
  })
  try {
    const session = await playSession.enter({ characterId, characterName })
    return { ok: true, session }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('play:switch', async (_e, mode) => {
  try {
    return { ok: true, session: await playSession.switchTo(mode) }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('play:manual-ready', (_e, error = null) => {
  if (!manualReadiness) return { ok: false }
  manualReadiness.finish(error)
  return { ok: !error }
})

ipcMain.handle('play:leave', async (_e, destination) => {
  await playSession.stop()
  closePreflightSession()
  return { ok: true, destination }
})

/// A directive (ADR 0003): best-effort, delivered as a relay-forged whisper.
/// Only meaningful once agent-client is actually running and connected.
ipcMain.handle('directive:send', (_e, text) => {
  if (!agent.running) return { ok: false, error: 'Not running' }
  const delivered = proxy.sendDirective(settings.characterName, text)
  if (!delivered) return { ok: false, error: 'Not connected yet — try again in a moment' }
  return { ok: true }
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
