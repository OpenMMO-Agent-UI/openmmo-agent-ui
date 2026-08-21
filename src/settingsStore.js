'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { app, safeStorage } = require('electron')

const { agentDir } = require('./runtimeEnv')
const { LANGUAGES, resolveLocale, setLanguage, t } = require('./i18n')
const { BACKENDS } = require('./backends')
const { parseToml } = require('./toml')

/// Player-selectable classes and the models that exist for them; the server
/// rejects the rest (merchant/guard are operator NPCs).
const CLASSES = [
  { id: 'knight', genders: ['male', 'female'] },
  { id: 'barbarian', genders: ['male', 'female'] },
  { id: 'caveman', genders: ['male', 'female'] },
  { id: 'valkyrie', genders: ['female'] },
  { id: 'ranger', genders: ['male'] },
  { id: 'rogue', genders: ['male', 'female'] },
  { id: 'priest', genders: ['male', 'female'] },
]

/// Same default as agent-client's own `DEFAULT_CLIENT_ID` in google_auth.rs —
/// a "TV and Limited Input" OAuth client registered in the same Google Cloud
/// project as the web client. The pre-flight session (src/characterSession.js)
/// and agent-client both sign in as this client by default, so they land in
/// the same credential cache; a different client_id only works against a
/// server whose own allowlist accepts it (see server/src/google_auth.rs).
const DEFAULT_GOOGLE_CLIENT_ID =
  '73507098079-cssj1h0eir5aj11d5hs81o9k7e466i55.apps.googleusercontent.com'
const DEFAULT_GOOGLE_CLIENT_SECRET = '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'

const DEFAULTS = {
  server: 'wss://openmmo.to.nexus/ws',
  terrain: 'https://openmmo.to.nexus',
  watchPort: 8808,
  authMode: 'google',
  googleClientId: DEFAULT_GOOGLE_CLIENT_ID,
  googleClientSecret: DEFAULT_GOOGLE_CLIENT_SECRET,
  npcAccount: '',
  characterName: '',
  characterClass: 'rogue',
  gender: 'male',
  llm: 'codex',
  models: { codex: 'gpt-5.4-mini', claude: 'sonnet', openrouter: 'qwen/qwen3.7-flash', openai: '' },
  openaiBaseUrl: 'https://ollama.com/v1',
  reasoningEffort: 'none',
  maxTokens: 4096,
  temperature: 0.7,
  /// Conversation history the OpenAI-compatible backend carries, system prompt
  /// included. agent-client trimmed to a hardcoded 41 before this existed.
  maxMessages: 41,
  minIntervalSecs: 5,
  idleIntervalSecs: 8,
  alwaysActive: true,
  /// What drives Automatic play: 'none' is the LLM agent, anything else is a
  /// rule-based worker inside agent-client (no LLM, no API key).
  workerKind: 'none',
  workerLevelMargin: 0,
  workerLowHealthPct: 70,
  workerFoodStock: 10,
  workerPotionStock: 10,
  workerScrollStock: 5,
  workerBagFullPct: 90,
  maxConcurrent: 2,
  requestTimeoutSecs: 120,
  rustLog: 'info',
  /// Overrides agent.js's dev-checkout search order. Packaged builds ignore
  /// this and always use the agent-client shipped beside their build metadata.
  /// No UI writes it any more; it stays as a hand-editable escape hatch for a
  /// dev checkout whose binary lives somewhere unusual.
  binaryPath: '',
  imported: false,
  toastFontSize: 13,
  toastOpacity: 75,
  toastPersistSecs: 7,
  toastFadeSecs: 0.4,
  toastMaxCount: 10,
  /// The game client's own BGM/SFX volume (percent, 0-100), mirrored into its
  /// iframe via postMessage — its real storage is that iframe's own
  /// localStorage (a different origin), this is only what gets pushed to it.
  bgmVolume: 100,
  bgmMuted: false,
  sfxVolume: 100,
  sfxMuted: false,
  /// OpenAI-compatible endpoint for spectator chat translation. Which language
  /// (and whether it runs at all) is the game client's own chat dropdown; only
  /// the provider lives here.
  translateBaseUrl: '',
  translateModel: '',
  /// Borrow the agent's own endpoint instead of the three fields above.
  /// Resolved at translation time, so changing the agent's provider carries
  /// over without re-ticking anything.
  translateUseLlmProvider: false,
  /// Anonymous usage analytics (src/telemetry.js). Checked at send time, so
  /// the Settings toggle takes effect immediately, no restart needed.
  telemetry: true,
  /// The UI's own language, and only the UI's: the agent's words come from its
  /// personality prompt, and chat translation from the game client's dropdown.
  /// Resolved from the OS on first run (see load), so a Taiwanese or Korean
  /// machine opens in its own language without being asked.
  language: 'en',
}

const SECRET_KEYS = ['openrouterKey', 'openaiKey', 'googleClientSecret', 'translateKey']

function isLoopbackUrl(value) {
  try {
    const host = new URL(String(value)).hostname
    return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)
  } catch {
    return false
  }
}

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json')
}

/// Where agent-client caches the Google refresh token — mirrors
/// `resolve_cache_path` in its google_auth.rs. Deleting this file is what
/// "sign out" means: the next start has nothing to reuse and runs the device
/// flow again.
function credentialPath() {
  if (process.platform === 'win32' && process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'onlinerpg', 'google.json')
  }
  return path.join(app.getPath('home'), '.config', 'onlinerpg', 'google.json')
}

function signedIn() {
  return fs.existsSync(credentialPath())
}

/// Returns false when there was nothing to remove, so the UI can say so
/// rather than claim a sign-out that never happened.
function signOut() {
  const file = credentialPath()
  if (!fs.existsSync(file)) return false
  fs.unlinkSync(file)
  return true
}

function encryptSecrets(secrets) {
  const json = JSON.stringify(secrets)
  if (!safeStorage.isEncryptionAvailable()) return { plain: json }
  return { enc: safeStorage.encryptString(json).toString('base64') }
}

function decryptSecrets(stored) {
  try {
    if (stored && stored.enc && safeStorage.isEncryptionAvailable()) {
      return JSON.parse(safeStorage.decryptString(Buffer.from(stored.enc, 'base64')))
    }
    if (stored && stored.plain) return JSON.parse(stored.plain)
  } catch {
    // A rotated OS key makes the blob unreadable; ask for the keys again
    // rather than refusing to start.
  }
  return {}
}

function load() {
  let stored = {}
  try {
    stored = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'))
  } catch {
    stored = {}
  }
  const secrets = decryptSecrets(stored.secrets)
  const settings = { ...DEFAULTS, ...stored, models: { ...DEFAULTS.models, ...(stored.models || {}) } }
  delete settings.secrets
  // Only the first run has no stored choice to respect.
  if (!LANGUAGES.some((l) => l.id === stored.language)) {
    settings.language = resolveLocale(app.getLocale())
  }
  setLanguage(settings.language)
  // A worker that no longer exists (one retired between versions) would fail
  // validation on every Play with nothing to point at — fall back to the LLM
  // agent instead of stranding the session.
  if (!WORKERS.includes(settings.workerKind)) settings.workerKind = 'none'
  for (const key of SECRET_KEYS) {
    settings[key] = Object.hasOwn(secrets, key) ? secrets[key] : DEFAULTS[key] || ''
  }
  return settings
}

function save(settings) {
  setLanguage(settings.language)
  const secrets = {}
  for (const key of SECRET_KEYS) secrets[key] = settings[key] || ''
  const plain = { ...settings }
  for (const key of SECRET_KEYS) delete plain[key]
  plain.secrets = encryptSecrets(secrets)
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true })
  fs.writeFileSync(settingsPath(), JSON.stringify(plain, null, 2))
  return settings
}

/// First-run import so an existing hand-written config keeps working —
/// notably `client_secret`, which ships only in the release tarball.
function importExistingConfig(settings) {
  if (settings.imported) return settings
  const file = path.join(agentDir(), 'data', 'config.toml')
  let parsed
  try {
    parsed = parseToml(fs.readFileSync(file, 'utf8'))
  } catch {
    return { ...settings, imported: true }
  }

  const npc = (parsed.npcs && parsed.npcs[0]) || {}
  const merged = { ...settings, imported: true }
  const take = (key, value) => {
    if (value !== undefined && value !== null && value !== '') merged[key] = value
  }

  // `server` in a generated config points at our own relay, not at a game
  // server. Importing that would make the relay dial a dead loopback port —
  // and it only takes one rename (userData is keyed on the app name) for a
  // fresh settings file to re-import a stale one.
  if (!isLoopbackUrl(parsed.server)) take('server', parsed.server)
  take('terrain', parsed.terrain || parsed.terrain_dir)
  take('watchPort', parsed.watch_port)
  take('maxConcurrent', parsed.max_concurrent)
  take('requestTimeoutSecs', parsed.request_timeout_secs)
  take('authMode', parsed.auth && parsed.auth.mode)
  take('googleClientId', parsed.auth && parsed.auth.client_id)
  take('googleClientSecret', parsed.auth && parsed.auth.client_secret)
  take('npcAccount', npc.account)
  take('characterName', npc.character_name)
  take('characterClass', npc.character_class)
  take('gender', npc.gender)
  take('llm', npc.llm)
  const worker = npc.worker || {}
  take('workerKind', worker.kind)
  take('workerLevelMargin', worker.level_margin)
  take('workerLowHealthPct', worker.low_health_pct)
  take('workerFoodStock', worker.food_stock)
  take('workerPotionStock', worker.potion_stock)
  take('workerScrollStock', worker.scroll_stock)
  take('workerBagFullPct', worker.bag_full_pct)
  take('minIntervalSecs', npc.min_interval_secs)
  take('idleIntervalSecs', npc.idle_interval_secs)
  if (typeof npc.always_active === 'boolean') merged.alwaysActive = npc.always_active

  merged.models = { ...merged.models }
  for (const backend of ['codex', 'claude', 'openrouter', 'openai']) {
    const table = npc[backend] || parsed[backend]
    if (table && table.model) merged.models[backend] = table.model
  }
  const openai = npc.openai || parsed.openai || {}
  take('openaiBaseUrl', openai.base_url)
  take('reasoningEffort', openai.reasoning_effort)
  take('openaiKey', openai.api_key)
  take('maxMessages', openai.max_messages)
  const openrouter = npc.openrouter || parsed.openrouter || {}
  take('openrouterKey', openrouter.api_key)
  take('maxTokens', openai.max_tokens || openrouter.max_tokens)
  take('temperature', openai.temperature || openrouter.temperature)

  return merged
}

/// Whether Automatic play runs a rule-based worker instead of the LLM agent.
/// A worker needs no backend, model or key, so every LLM check is skipped.
function usesWorker(s) {
  return Boolean(s.workerKind) && s.workerKind !== 'none'
}

const WORKERS = ['none', 'fighter', 'fisher']

/// Refuse to start on the mistakes agent-client would only report after the
/// window has already switched to the spectator view.
function validate(s) {
  const errors = []
  if (!/^wss?:\/\//.test(s.server)) errors.push(t('Server URL must start with ws:// or wss://'))
  else if (!/\/ws\/?$/.test(s.server)) errors.push(t('Server URL must end in /ws'))
  if (s.authMode === 'npc_token' && !/^npc_/.test(s.npcAccount)) {
    errors.push(t('Token auth needs an account name starting with npc_'))
  }
  const cls = CLASSES.find((c) => c.id === s.characterClass)
  if (!cls) errors.push(t('Unknown class {class}', { class: s.characterClass }))
  else if (!cls.genders.includes(s.gender)) {
    errors.push(
      t('{class} has no {gender} model — pick {allowed}', {
        class: t(s.characterClass),
        gender: t(s.gender),
        allowed: cls.genders.map((g) => t(g)).join(t(' or ')),
      }),
    )
  }
  if (!WORKERS.includes(s.workerKind || 'none')) {
    errors.push(t('Unknown worker {worker}', { worker: s.workerKind }))
  }
  const backend = BACKENDS.find((b) => b.id === s.llm)
  if (!usesWorker(s) && backend && backend.kind === 'http' && !s.models[s.llm]) {
    errors.push(t('Pick a model for {backend}', { backend: backend.label }))
  }
  // Under Google auth, the pre-flight session (characterSession.js) always
  // resolves an exact character before Play — agent-client should never fall
  // back to its own characters.first()/auto-create guesswork.
  if (s.authMode === 'google' && !s.characterName) {
    errors.push(t('Choose or create a character first'))
  }
  if (!usesWorker(s) && s.llm === 'openai' && !s.openaiBaseUrl) {
    errors.push(t('OpenAI-compatible mode needs a base URL'))
  }
  if (isLoopbackUrl(s.server)) {
    errors.push(
      t(
        "Server points at this machine ({server}). That is the relay's own address, " +
          'not a game server — set it back to {default} under Connection.',
        { server: s.server, default: DEFAULTS.server },
      ),
    )
  }
  return errors
}

module.exports = {
  CLASSES,
  BACKENDS,
  DEFAULT_GOOGLE_CLIENT_ID,
  DEFAULTS,
  credentialPath,
  signedIn,
  signOut,
  load,
  save,
  importExistingConfig,
  usesWorker,
  validate,
  WORKERS,
}
