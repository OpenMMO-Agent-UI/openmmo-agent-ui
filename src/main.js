'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { app, BrowserWindow, ipcMain, safeStorage, shell } = require('electron')
const { preserveLegacyUserData } = require('./appPaths')

// productName controls Electron's default userData directory. Keep the
// pre-rename location so an upgrade retains profiles, secrets, and character
// data while the visible application name changes.
preserveLegacyUserData(app)

const settingsStore = require('./settingsStore')
const i18n = require('./i18n')
const personalityText = require('./personalityText')
const { agentDir, seedRuntimeData } = require('./runtimeEnv')
const { renderConfigToml } = require('./configToml')
const { AgentProcess } = require('./agent')
const { ClientServer, distReady } = require('./server')
const { AgentProxy } = require('./proxy')
const googleAuth = require('./googleAuth')
const characterSession = require('./characterSession')
const { ConnectionProfileStore } = require('./connectionProfiles')
const { CharacterStore } = require('./characterStore')
const { PlaySessionCoordinator } = require('./playSession')
const { validateLlmSettings } = require('./llmValidation')
const { translateText } = require('./translate')
const telemetry = require('./telemetry')
const updater = require('./updater')

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
  (worn) => send('agent:worn', worn),
  // Trained skills, which the panel API does not publish either — same
  // push-as-it-changes path as the gear above.
  (skills) => send('agent:skills', skills)
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
// The pre-flight session: open for the lifetime of the Character
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
    title: 'OpenMMO Agent UI',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The agent keeps running while the window is hidden; throttling stalls its timers.
      backgroundThrottling: false,
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
    // A rule worker emits the same action JSON under its own kind, so the
    // captions keep working with no model in the loop.
    if (item.k === 'worker') {
      try {
        const parsed = JSON.parse(item.m)
        if (Array.isArray(parsed.actions)) lastActions = parsed.actions
      } catch {
        // A turn we can't read is one caption missed, not a broken poll.
      }
      continue
    }
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
    // A worker's turns feed the action captions but not the Thoughts panel:
    // there is no model thinking, and LLM-shaped entries there would lie.
    const visible = items.filter((item) => item.k !== 'worker')
    if (visible.length) send('agent:feed', visible)
  }
  send('agent:vitals', {
    connected: body.connected === true,
    self: body.self || null,
    gold: body.gold ?? null,
    time: body.time || null,
    bag: body.bag || [],
    weight: body.weight || null,
    attributes: body.attributes || null,
    hunger: body.hunger || null,
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
  if (!mirror) throw new Error(i18n.t('The relay is not listening yet.'))
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
      throw new Error(i18n.t('Connection-profile secrets cannot be decrypted'))
    },
  }
}

function selectedProfileSettings() {
  return profileStore.withSecrets(profileStore.selected().id)
}

function applySelectedProfile() {
  const profile = selectedProfileSettings()
  settings = settingsStore.save({
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
  // A rule-based worker drives the character without an LLM, so there is
  // no backend, model or key to check.
  if (settingsStore.usesWorker(settings)) return { ok: true }
  const backend = settingsStore.BACKENDS.find((candidate) => candidate.id === settings.llm)
  if (!backend || backend.kind === 'none') {
    return { ok: false, error: i18n.t('Set up an LLM to use Automatic play') }
  }
  if (backend.kind === 'http' && !settings.models[settings.llm]) {
    return { ok: false, error: i18n.t('Pick a model for {backend}', { backend: backend.label }) }
  }
  if (settings.llm === 'openrouter' && !settings.openrouterKey) {
    return { ok: false, error: i18n.t('OpenRouter needs an API key') }
  }
  if (settings.llm === 'openai' && (!settings.openaiBaseUrl || !settings.openaiKey)) {
    return { ok: false, error: i18n.t('OpenAI-compatible mode needs a Base URL and API key') }
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
    const timeout = setTimeout(() => finish(new Error(i18n.t('AI did not enter the world in time'))), 30000)
    const ready = (url) => finish(null, url)
    const fatal = (message) => finish(new Error(message))
    const state = (next) => {
      if (!next.running && next.exitCode != null) finish(new Error(i18n.t('AI exited before entering the world')))
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
    cancel = () => finish(new Error(i18n.t('AI startup canceled')))
  })
  promise.cancel = cancel
  return promise
}

async function startManualController(context) {
  closePreflightSession()
  const profile = selectedProfileSettings()
  const refreshToken = profileStore.credential(profile.id)
  if (!refreshToken) throw new Error(i18n.t('Not signed in'))
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
      reject(new Error(i18n.t('Manual client did not enter the world in time')))
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

/// Aptabase refuses to initialize once the app is ready ("`initialize` must
/// be invoked before the app is ready"), silently disabling tracking — so
/// this cannot live inside whenReady() with the rest of startup. Reading
/// `settings` through a closure keeps the toggle live: it is checked at
/// send time, and `settings` is loaded before the first track() call below.
telemetry.init(() => settings?.telemetry !== false)

app.whenReady().then(() => {
  seedRuntimeData()
  settings = settingsStore.importExistingConfig(settingsStore.load())
  settingsStore.save(settings)
  telemetry.track('app_started')
  const legacyRefreshToken = googleAuth.cachedRefreshToken(settings.googleClientId)
  profileStore = new ConnectionProfileStore({
    file: path.join(app.getPath('userData'), 'connection-profiles.json'),
    cipher: profileCipher(),
    builtin: {
      name: 'openmmo.to.nexus',
      serverUrl: settingsStore.DEFAULTS.server,
      terrainOrigin: settingsStore.DEFAULTS.terrain,
      googleClientId: settingsStore.DEFAULTS.googleClientId,
      googleClientSecret: settingsStore.DEFAULTS.googleClientSecret || '',
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
  updater.init({ send, stopAgent: () => agent.stopAndWait() })
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  void playSession?.stop()
  app.quit()
})

/// Quitting waits for agent-client to actually exit rather than firing a
/// kill and moving on. Every exit path runs through here, including the one
/// electron-updater takes to install a downloaded update — and an installer
/// that starts while the child still holds its files open leaves the app
/// half-replaced. The child's own stop() escalates to SIGKILL, and the race
/// below is the last resort so a wedged process can never make the app
/// unquittable.
let quitting = false
app.on('before-quit', (event) => {
  stopFeedPolling()
  clientServer.stop()
  proxy.stop()
  updater.stop()
  if (quitting) return
  quitting = true
  event.preventDefault()
  const settled = Promise.race([
    agent.stopAndWait(),
    new Promise((resolve) => setTimeout(resolve, 8000)),
  ])
  void settled.then(() => app.quit())
})

/// The renderer asks for a dictionary at startup and on every switch; the file
/// read and its cache stay on this side (see src/i18n.js).
ipcMain.handle('i18n:dict', (_e, language) => i18n.dictionary(language))

ipcMain.handle('app:info', () => ({
  settings,
  appVersion: app.getVersion(),
  update: updater.current(),
  backends: settingsStore.BACKENDS,
  classes: settingsStore.CLASSES,
  agentDir: agentDir(),
  status: agent.status(),
  log: agent.log,
  clientBuilt: distReady(),
  signedIn: settingsStore.signedIn(),
  credentialPath: settingsStore.credentialPath(),
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
  if (!profile) return { ok: false, error: i18n.t('Connection profile not found') }
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
  settings = settingsStore.save({ ...settings, ...patch, models: { ...settings.models, ...(patch.models || {}) } })
  return settings
})

ipcMain.handle('settings:validate', (_e, patch) => settingsStore.validate({ ...settings, ...patch }))

ipcMain.handle('settings:apply', async (_e, patch) => {
  const candidate = {
    ...settings,
    ...patch,
    models: { ...settings.models, ...(patch.models || {}) },
  }
  const errors = settingsStore.validate(candidate)
  if (errors.length) return { ok: false, errors }
  // Nothing to reach for a worker: no CLI to be signed into, no endpoint to
  // answer. Checking anyway would refuse to save the very choice that says
  // "no LLM".
  if (!settingsStore.usesWorker(candidate)) {
    const live = await validateLlmSettings(candidate)
    if (!live.ok) return { ok: false, errors: [live.error] }
  }
  settings = settingsStore.save(candidate)
  return { ok: true, settings }
})

ipcMain.handle('config:preview', () => renderConfigToml(settings))

/// null rather than an error: the spectator client falls back to its on-device
/// translator when this returns nothing, and a failed line keeps its original
/// text rather than announcing itself in the chat panel.
ipcMain.handle('translate:text', async (_e, { text, target }) => {
  const result = await translateText(settings, { text, target })
  return result.ok ? result.text : null
})

const TRANSLATE_SAMPLE = '보시겠소. 횃불, 빵, 약 있소.'
const TRANSLATE_SAMPLE_TARGET = 'Chinese (Traditional)'

ipcMain.handle('translate:test', async (_e, patch) => {
  const result = await translateText(
    { ...settings, ...patch },
    { text: TRANSLATE_SAMPLE, target: TRANSLATE_SAMPLE_TARGET },
  )
  return { ...result, sample: TRANSLATE_SAMPLE }
})

/// agent-client talks to our loopback relay; the relay holds the only
/// connection to the real server. `settings.server` stays the upstream URL —
/// it is what the user configured and what the relay dials.
async function startAgent() {
  const errors = settingsStore.validate(settings)
  if (errors.length) return { ok: false, errors }
  // The pre-flight session already resolved the exact character agent-client
  // is about to enter with — nothing left for it to do.
  closePreflightSession()
  currentCharacters = []
  // agent-client hard-errors on a configured prompt file that doesn't exist —
  // guarantee both before every start, not just when the player opens the
  // personality-prompt editor.
  personalityText.ensureUserPrompt()
  if (settings.characterName) {
    materializePersonality(profileStore.selected().id, activeCharacterId, settings.characterName)
    personalityText.ensureInstancePrompt(settings.characterName)
  }
  try {
    await proxy.start(settings.server)
    const status = await agent.start({ ...settings, server: proxy.agentUrl })
    // Which backends/models people actually run Automatic play with — model
    // ids only, never keys or prompts.
    const worker = settingsStore.usesWorker(settings)
    telemetry.track('agent_started', {
      backend: worker ? `worker:${settings.workerKind}` : settings.llm,
      model: worker ? '' : settings.models[settings.llm] || '',
    })
    return { ok: true, status }
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
  const legacy = personalityText.instancePromptPath(characterName)
  if (scoped && !fs.existsSync(scoped) && fs.existsSync(legacy)) {
    fs.mkdirSync(path.dirname(scoped), { recursive: true })
    fs.copyFileSync(legacy, scoped)
  }
  if (scoped && fs.existsSync(scoped)) {
    fs.mkdirSync(path.dirname(legacy), { recursive: true })
    fs.copyFileSync(scoped, legacy)
  }
}

/// Sellable/dropable marks on bag items — the source of truth for the bag
/// panel's checkboxes; instance.txt's own copy is just a rendering of this
/// for agent-client to read.
ipcMain.handle('labels:get', (_e, { characterId }) => {
  if (!characterId) return { sellable: [], dropable: [] }
  return characterStore.open('labels', profileStore.selected().id, characterId).read()
})

ipcMain.handle('labels:save', (_e, { characterId, characterName, labels }) => {
  if (!characterId) return { ok: false, error: i18n.t('No character selected') }
  const profileId = profileStore.selected().id
  const clean = {
    sellable: Array.isArray(labels?.sellable) ? [...new Set(labels.sellable)] : [],
    dropable: Array.isArray(labels?.dropable) ? [...new Set(labels.dropable)] : [],
  }
  characterStore.open('labels', profileId, characterId).write(clean)
  // Re-render instance.txt's labels block from the character's existing prose
  // plus these new marks.
  const file = personalityPath(profileId, characterId)
  let prose = ''
  try {
    prose = personalityText.splitInstanceText(fs.readFileSync(file, 'utf8')).prose
  } catch {
    prose = ''
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, personalityText.composeInstanceText(prose, clean))
  if (characterName) materializePersonality(profileId, characterId, characterName)
  return { ok: true, labels: clean }
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
  settings = settingsStore.save({ ...settings, characterName: '' })
  return { removed, wasRunning, signedIn: settingsStore.signedIn() }
})

/// Cheap, no-network check: is there a cached Google credential for the
/// currently configured client? Drives the Login screen's initial
/// Continue-vs-sign-in state.
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
  if (!profile) throw new Error(i18n.t('Connection profile no longer exists'))
  const idToken = await googleAuth.mintIdToken(
    refreshToken,
    profile.googleClientId,
    profile.googleClientSecret,
  )
  const session = await characterSession.openSession(profile.serverUrl, idToken)
  if (generation !== authGeneration || profileStore.selected().id !== profileId) {
    session.close()
    return { ok: false, canceled: true, error: i18n.t('Sign-in canceled') }
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
  if (!refreshToken) return { ok: false, error: i18n.t('Not signed in') }
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
    if (!refreshToken) throw new Error(i18n.t('No cached credential to continue with'))
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
  if (!character) return { ok: false, error: i18n.t('That character is no longer in this account roster') }
  const characterName = character.name
  settings = settingsStore.save({ ...settings, characterName })
  activeCharacterId = characterId
  profileStore.rememberSession(profileStore.selected().id, {
    account: profileStore.selected().lastSession?.account || null,
    characterId,
  })
  try {
    const session = await playSession.enter({ characterId, characterName })
    telemetry.track('play_entered', { mode: session?.mode || 'unknown' })
    return { ok: true, session }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('play:switch', async (_e, mode) => {
  try {
    const session = await playSession.switchTo(mode)
    telemetry.track('mode_switched', { mode })
    return { ok: true, session }
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

/// A directive: best-effort, delivered as a relay-forged whisper.
/// Only meaningful once agent-client is actually running and connected.
ipcMain.handle('directive:send', (_e, text) => {
  if (!agent.running) return { ok: false, error: i18n.t('Not running') }
  const delivered = proxy.sendDirective(settings.characterName, text)
  if (!delivered) return { ok: false, error: i18n.t('Not connected yet — try again in a moment') }
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

ipcMain.handle('update:check', () => updater.check())

ipcMain.handle('update:install', () => updater.install())

ipcMain.handle('update:download-page', () => updater.openDownloadPage())

ipcMain.handle('shell:open', (_e, target) => {
  // A button whose target has not been filled in yet must do nothing, not
  // throw an unhandled rejection into the renderer.
  if (typeof target !== 'string' || !target) return { ok: false }
  if (/^https?:\/\//.test(target)) shell.openExternal(target)
  else shell.openPath(target)
  return { ok: true }
})
