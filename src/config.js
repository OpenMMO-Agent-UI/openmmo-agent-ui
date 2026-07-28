'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { app, safeStorage } = require('electron')

const { parseToml, tomlString } = require('./toml')

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

const BACKENDS = [
  { id: 'codex', label: 'Codex CLI', kind: 'cli', models: ['gpt-5.4-mini', 'gpt-5.4', 'o4-mini'] },
  { id: 'claude', label: 'Claude CLI', kind: 'cli', models: ['sonnet', 'opus', 'haiku'] },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    kind: 'http',
    envKey: 'OPENROUTER_API_KEY',
    // Suggestions only; the field takes any id from openrouter.ai/models.
    // Measured on the agent's real turn: these keep the distance rule and read
    // the bag correctly. Cheaper models exist and invent inventory.
    models: [
      'qwen/qwen3.7-flash',
      'openai/gpt-oss-20b',
      'anthropic/claude-haiku-4.5',
    ],
  },
  {
    id: 'openai',
    label: 'OpenAI-compatible',
    kind: 'http',
    envKey: 'OPENAI_COMPAT_API_KEY',
    models: [],
  },
  { id: 'none', label: 'No LLM (idle)', kind: 'none', models: [] },
]

const DEFAULTS = {
  server: 'wss://openmmo.to.nexus/ws',
  terrain: 'https://openmmo.to.nexus',
  watchPort: 8808,
  authMode: 'google',
  npcAccount: '',
  characterName: '',
  characterClass: 'rogue',
  gender: 'male',
  llm: 'codex',
  models: { codex: 'gpt-5.4-mini', claude: 'sonnet', openrouter: 'qwen/qwen3.7-flash', openai: '' },
  openaiBaseUrl: 'https://ollama.com/v1',
  reasoningEffort: 'none',
  maxTokens: 1024,
  temperature: 0.7,
  minIntervalSecs: 5,
  idleIntervalSecs: 8,
  alwaysActive: true,
  maxConcurrent: 2,
  requestTimeoutSecs: 120,
  rustLog: 'info',
  binaryPath: '',
  imported: false,
}

const SECRET_KEYS = ['openrouterKey', 'openaiKey', 'googleClientSecret']

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

function repoRoot() {
  return path.resolve(__dirname, '..', '..')
}

/// Working directory for the child process: agent-client resolves every path
/// in its config relative to cwd, so it must be the dir that holds `data/`.
function agentDir() {
  const packaged = path.join(process.resourcesPath || '', 'agent-client')
  if (app.isPackaged && fs.existsSync(path.join(packaged, 'data'))) return packaged
  return path.join(repoRoot(), 'agent-client')
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
  for (const key of SECRET_KEYS) settings[key] = secrets[key] || ''
  return settings
}

function save(settings) {
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
  take('googleClientSecret', parsed.auth && parsed.auth.client_secret)
  take('npcAccount', npc.account)
  take('characterName', npc.character_name)
  take('characterClass', npc.character_class)
  take('gender', npc.gender)
  take('llm', npc.llm)
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
  const openrouter = npc.openrouter || parsed.openrouter || {}
  take('openrouterKey', openrouter.api_key)
  take('maxTokens', openai.max_tokens || openrouter.max_tokens)
  take('temperature', openai.temperature || openrouter.temperature)

  return merged
}

/// Rendered fresh on every start. Keys never land here — they go to the child
/// process as environment variables instead, so a config file someone pastes
/// into an issue carries no credential.
function renderConfigToml(s) {
  const lines = [
    '# Generated by the OpenMMO agent desktop app. Edits are overwritten on',
    '# every start; change the values in the app instead.',
    '',
    `server = ${tomlString(s.server)}`,
    `terrain = ${tomlString(s.terrain)}`,
    'terrain_cache = "data/cache/height"',
    `watch_port = ${Number(s.watchPort) || 0}`,
    `max_concurrent = ${Number(s.maxConcurrent) || 2}`,
    `request_timeout_secs = ${Number(s.requestTimeoutSecs) || 120}`,
    '',
    '[auth]',
    `mode = ${tomlString(s.authMode)}`,
  ]
  if (s.authMode === 'google' && s.googleClientSecret) {
    lines.push(`client_secret = ${tomlString(s.googleClientSecret)}`)
  }

  lines.push('', '[claude]', `model = ${tomlString(s.models.claude)}`)
  lines.push('', '[codex]', `model = ${tomlString(s.models.codex)}`)
  lines.push(
    '',
    '[openrouter]',
    `model = ${tomlString(s.models.openrouter)}`,
    `max_tokens = ${Number(s.maxTokens) || 1024}`,
    `temperature = ${Number(s.temperature)}`,
  )
  lines.push(
    '',
    '[openai]',
    `base_url = ${tomlString(s.openaiBaseUrl)}`,
    `model = ${tomlString(s.models.openai)}`,
    `max_tokens = ${Number(s.maxTokens) || 1024}`,
    `temperature = ${Number(s.temperature)}`,
    `reasoning_effort = ${tomlString(s.reasoningEffort)}`,
  )

  lines.push('', '[[npcs]]', `llm = ${tomlString(s.llm)}`)
  if (s.authMode === 'google') {
    lines.push(`character_name = ${tomlString(s.characterName)}`)
  } else {
    lines.push(`account = ${tomlString(s.npcAccount)}`)
    if (s.characterName) lines.push(`character_name = ${tomlString(s.characterName)}`)
  }
  lines.push(
    `character_class = ${tomlString(s.characterClass)}`,
    `gender = ${tomlString(s.gender)}`,
    `min_interval_secs = ${Number(s.minIntervalSecs) || 5}`,
    `idle_interval_secs = ${Number(s.idleIntervalSecs) || 15}`,
    `always_active = ${s.alwaysActive ? 'true' : 'false'}`,
    // Without this the `memory_update` the model writes every turn is thrown
    // away, and the agent relearns the same town from scratch on each restart.
    'memory_file = "data/memory.txt"',
    '',
  )
  return lines.join('\n')
}

/// Refuse to start on the mistakes agent-client would only report after the
/// window has already switched to the spectator view.
function validate(s) {
  const errors = []
  if (!/^wss?:\/\//.test(s.server)) errors.push('Server URL must start with ws:// or wss://')
  else if (!/\/ws\/?$/.test(s.server)) errors.push('Server URL must end in /ws')
  if (s.authMode === 'google' && !s.characterName.trim()) {
    errors.push('Google sign-in needs a character name (unique across the server)')
  }
  if (s.authMode === 'npc_token' && !/^npc_/.test(s.npcAccount)) {
    errors.push('Token auth needs an account name starting with npc_')
  }
  const cls = CLASSES.find((c) => c.id === s.characterClass)
  if (!cls) errors.push(`Unknown class ${s.characterClass}`)
  else if (!cls.genders.includes(s.gender)) {
    errors.push(`${s.characterClass} has no ${s.gender} model — pick ${cls.genders.join(' or ')}`)
  }
  const backend = BACKENDS.find((b) => b.id === s.llm)
  if (backend && backend.kind === 'http' && !s.models[s.llm]) {
    errors.push(`Pick a model for ${backend.label}`)
  }
  if (s.llm === 'openai' && !s.openaiBaseUrl) errors.push('OpenAI-compatible mode needs a base URL')
  if (isLoopbackUrl(s.server)) {
    errors.push(
      `Server points at this machine (${s.server}). That is the relay's own address, ` +
        `not a game server — set it back to ${DEFAULTS.server} under Connection.`,
    )
  }
  return errors
}

function writeConfig(settings) {
  const dir = path.join(agentDir(), 'data')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'config.toml')
  const backup = `${file}.bak`
  if (fs.existsSync(file) && !fs.existsSync(backup)) fs.copyFileSync(file, backup)
  fs.writeFileSync(file, renderConfigToml(settings))
  return file
}

module.exports = {
  BACKENDS,
  credentialPath,
  signOut,
  signedIn,
  CLASSES,
  DEFAULTS,
  agentDir,
  importExistingConfig,
  load,
  renderConfigToml,
  repoRoot,
  save,
  validate,
  writeConfig,
}
