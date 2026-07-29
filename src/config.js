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

/// Same default as agent-client's own `DEFAULT_CLIENT_ID` in google_auth.rs —
/// a "TV and Limited Input" OAuth client registered in the same Google Cloud
/// project as the web client. The pre-flight session (src/characterSession.js)
/// and agent-client both sign in as this client by default, so they land in
/// the same credential cache; a different client_id only works against a
/// server whose own allowlist accepts it (see server/src/google_auth.rs).
const DEFAULT_GOOGLE_CLIENT_ID =
  '73507098079-cssj1h0eir5aj11d5hs81o9k7e466i55.apps.googleusercontent.com'

/// Sender name on every relay-forged directive whisper (see proxy.js and
/// ADR 0003). Fixed rather than the player's Google display name, so the
/// shipped default prompt can name it literally.
const DIRECTIVE_SENDER = 'Director'

const DEFAULTS = {
  server: 'wss://openmmo.to.nexus/ws',
  terrain: 'https://openmmo.to.nexus',
  watchPort: 8808,
  authMode: 'google',
  googleClientId: DEFAULT_GOOGLE_CLIENT_ID,
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

/// The OpenMMO checkout `agentDir()`/`clientDist()` (server.js) resolve
/// `agent-client/` and `client/` against in dev. `OPENMMO_CHECKOUT` (the
/// packaging scripts' own env var) wins when set; otherwise this assumes the
/// README's documented layout — openmmo-client cloned *inside* the OpenMMO
/// checkout — which only holds if the two are actually nested. Checked out
/// as siblings instead (as common as nested in practice), this silently
/// resolves to nonsense (a data/ or client/dist that was never there) —
/// found testing Play itself, the same way protocolVersion()'s equivalent
/// bug was found testing the pre-flight session.
function repoRoot() {
  if (process.env.OPENMMO_CHECKOUT) return process.env.OPENMMO_CHECKOUT
  return path.resolve(__dirname, '..', '..')
}

/// Where a packaged build ships the agent-client binary and its seed data.
/// Read-only: once code-signed on macOS (or installed under Program Files on
/// Windows), nothing here can be rewritten at runtime.
function packagedSeedDir() {
  return path.join(process.resourcesPath || '', 'agent-client')
}

/// Working directory for the child process: agent-client resolves every path
/// in its config relative to cwd, so it must be the dir that holds `data/` —
/// and that dir has to be writable, since config.toml is rewritten every
/// start and agent-client itself writes memory.txt and the terrain tile
/// cache into it. A dev checkout is already writable; a packaged build's
/// resources are not, so it gets a runtime dir under userData instead,
/// seeded from the read-only bundle by seedRuntimeData().
function agentDir() {
  if (app.isPackaged) return path.join(app.getPath('userData'), 'agent-runtime')
  return path.join(repoRoot(), 'agent-client')
}

/// The subset of data/ that is fixed content rather than runtime state —
/// safe to ship read-only and copy into place once. Everything else
/// (config.toml, memory.txt, data/cache/*) is either regenerated on every
/// start or grows at runtime and has no business being in the bundle.
const SEED_ENTRIES = ['system_prompt.txt', 'user_prompts', 'templates', 'animation_durations.json']

/// Copies a seed entry into the runtime dir the first time it's missing.
/// Never overwrites — a hand-edited user_prompts/ or a relaunch after the
/// files already exist must leave them alone.
function copySeedEntry(src, dest) {
  if (!fs.existsSync(src) || fs.existsSync(dest)) return
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.cpSync(src, dest, { recursive: true })
}

function seedRuntimeData() {
  if (!app.isPackaged) return
  const seedData = path.join(packagedSeedDir(), 'data')
  const runtimeData = path.join(agentDir(), 'data')
  for (const entry of SEED_ENTRIES) {
    copySeedEntry(path.join(seedData, entry), path.join(runtimeData, entry))
  }
}

/// { commit, protocolVersion } of the OpenMMO checkout this build was staged
/// from — written by scripts/package-resources.sh. Null outside a packaged
/// build, or if a build predates this stamp.
function buildInfo() {
  if (!app.isPackaged) return null
  try {
    return JSON.parse(fs.readFileSync(path.join(packagedSeedDir(), 'build-info.json'), 'utf8'))
  } catch {
    return null
  }
}

/// The wire protocol version `characterSession.js`'s hand-encoded messages
/// were written against (ADR 0002's protocol guard sends this in
/// `ClientInfo`). This is a fact about *this JS code* — which struct shapes
/// it knows how to build — not about whatever `agent-client` binary the user
/// has configured; those are independent and checked separately (agent.js's
/// `scanForProtocolMismatch` catches a real agent-client at its own runtime).
/// Deriving this from the configured binary/checkout was tried and found
/// broken the moment the binary was a bare copy outside any checkout (e.g.
/// `~/Downloads/agent-client`) — there's no directory to read
/// `shared/src/lib.rs` from at all in that case, even though the binary
/// itself may be perfectly current. A hand-updated constant has no such
/// blind spot: bump it (and verify characterSession.js's message shapes
/// still match) whenever `scripts/check-protocol.js` reports a new number.
const CHARACTER_SESSION_PROTOCOL_VERSION = 9

function protocolVersion() {
  return CHARACTER_SESSION_PROTOCOL_VERSION
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
  take('googleClientId', parsed.auth && parsed.auth.client_id)
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
  if (s.authMode === 'google') {
    // Must match whatever client_id the pre-flight session (characterSession.js)
    // signed in as: agent-client only reuses the cached refresh token when the
    // cache's client_id equals this one (google_auth.rs), so a mismatch here
    // silently throws away the sign-in Login already did and re-prompts.
    lines.push(`client_id = ${tomlString(s.googleClientId)}`)
    if (s.googleClientSecret) lines.push(`client_secret = ${tomlString(s.googleClientSecret)}`)
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
  if (s.authMode !== 'google') lines.push(`account = ${tomlString(s.npcAccount)}`)
  // Google auth resolves the account from the id_token alone and hands back
  // its whole character list — agent-client enters the first one if no name
  // is given, or creates one if the name doesn't match. A name is only
  // needed to pick among several characters or to create a new one.
  if (s.characterName) lines.push(`character_name = ${tomlString(s.characterName)}`)
  lines.push(
    `character_class = ${tomlString(s.characterClass)}`,
    `gender = ${tomlString(s.gender)}`,
    `min_interval_secs = ${Number(s.minIntervalSecs) || 5}`,
    `idle_interval_secs = ${Number(s.idleIntervalSecs) || 15}`,
    `always_active = ${s.alwaysActive ? 'true' : 'false'}`,
    // Without this the `memory_update` the model writes every turn is thrown
    // away, and the agent relearns the same town from scratch on each restart.
    'memory_file = "data/memory.txt"',
  )
  // agent-client hard-errors on a configured prompt file that doesn't exist
  // (load_system_prompt), unlike memory_file's own missing-file tolerance —
  // so this is only ever written once ensureInstancePrompt() below has
  // guaranteed the file is actually there.
  if (s.characterName) lines.push(`instance_prompt = ${tomlString(instancePromptRelativePath(s.characterName))}`)
  lines.push('')
  return lines.join('\n')
}

const NPC_DATA_DIR = 'data/npcs'

function instancePromptRelativePath(characterName) {
  return `${NPC_DATA_DIR}/${characterName}/instance.txt`
}

/// Absolute path to a character's own instance prompt — the personality
/// prompt players actually edit, layered on top of the fixed general persona
/// in user_prompt.txt, mirroring agent-client's own per-registry-NPC
/// instance.txt convention (main.rs), just keyed by character name instead
/// of registry id.
function instancePromptPath(characterName) {
  return path.join(agentDir(), instancePromptRelativePath(characterName))
}

/// Guarantees the file renderConfigToml() is about to reference actually
/// exists — never overwrites existing content.
function ensureInstancePrompt(characterName) {
  const file = instancePromptPath(characterName)
  if (fs.existsSync(file)) return
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '')
}

/// user_prompt.txt has no editor in the app any more — the personality
/// prompt (instance.txt, above) is the only thing players write. Without
/// this, a character who never had one created (nothing in the UI does that
/// any more) would get no persona role layer at all: agent-client only
/// includes user_prompt.txt in the prompt if the file exists (orchestrator.rs
/// build_system_prompt), it doesn't fall back to a preset on its own.
function ensureUserPrompt() {
  const dir = path.join(agentDir(), 'data')
  const file = path.join(dir, 'user_prompt.txt')
  if (fs.existsSync(file)) return
  const preset = path.join(dir, 'user_prompts', 'newcomer.txt')
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.copyFileSync(preset, file)
  } catch {
    // No newcomer preset to seed from (unusual layout) — the character just
    // runs on the shared system prompt and its own instance.txt instead.
  }
}

/// Refuse to start on the mistakes agent-client would only report after the
/// window has already switched to the spectator view.
function validate(s) {
  const errors = []
  if (!/^wss?:\/\//.test(s.server)) errors.push('Server URL must start with ws:// or wss://')
  else if (!/\/ws\/?$/.test(s.server)) errors.push('Server URL must end in /ws')
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
  // Under Google auth, the pre-flight session (characterSession.js) always
  // resolves an exact character before Play — agent-client should never fall
  // back to its own characters.first()/auto-create guesswork (ADR 0001).
  if (s.authMode === 'google' && !s.characterName) {
    errors.push('Choose or create a character first')
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
  DEFAULT_GOOGLE_CLIENT_ID,
  DIRECTIVE_SENDER,
  agentDir,
  instancePromptPath,
  ensureInstancePrompt,
  ensureUserPrompt,
  packagedSeedDir,
  seedRuntimeData,
  buildInfo,
  protocolVersion,
  importExistingConfig,
  load,
  renderConfigToml,
  repoRoot,
  save,
  validate,
  writeConfig,
}
