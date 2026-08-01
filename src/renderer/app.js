'use strict'

const api = window.agentApp
const $ = (id) => document.getElementById(id)

let settings = null
let backends = []
let classes = []
let running = false
let dirtyWhileRunning = false
let profiles = []
let selectedProfileId = null
let editingProfileId = null
let workflow = null
let playMode = 'ai'
let settingsDirty = false
let retryCountdownTimer = null
let settingsSnapshot = null
/// The spectator scene's URL, once the relay is listening and the agent has a
/// session to mirror. One view, so one URL: there is nothing to switch between.
let sceneUrl = null
const feedHidden = new Set()

// Pre-flight session state (ADR 0001): the character list fetched at sign-in,
// and which one is chosen for this Play. Bumped on every sign-in attempt so
// a stale device-flow poll (abandoned via "Start over") can't resolve later
// and yank the screen back.
let characters = []
let selectedCharacterId = null
let signInGeneration = 0

// A directive (ADR 0003): best-effort, so its reply is tracked and shown
// right next to what was sent rather than assumed to have landed.
let pendingDirective = null

/// monster_id -> display name, learned from "Monster: kobold [m1045_5] HP
/// 5/5 ..." lines in the agent's own llm-prompt feed items (agent-client's
/// state.rs format_world_state) — the id is what actions echo back and the
/// server matches on, never the name, so labels need this lookup to show
/// something readable. Never cleared: a monster out of view in a later
/// prompt should still resolve for an action against it moments earlier.
const monsterNames = new Map()
const MONSTER_LINE_RE = /Monster:\s*(\S+)\s*\[([^\]]+)\]/g

function learnMonsterNames(text) {
  MONSTER_LINE_RE.lastIndex = 0
  let match
  while ((match = MONSTER_LINE_RE.exec(text))) {
    monsterNames.set(match[2], match[1])
  }
}

const FEED_KINDS = [
  'llm-prompt',
  'llm-response',
  'llm-error',
  'chat',
  'combat',
  'trade',
  'system',
]

/// Plain settings fields; `characterName` (Login screen), `model` and
/// `apiKey` (per-backend) are handled apart from this generic map.
const FIELDS = {
  characterClass: 'text',
  gender: 'text',
  alwaysActive: 'bool',
  minIntervalSecs: 'int',
  idleIntervalSecs: 'int',
  llm: 'text',
  openaiBaseUrl: 'text',
  maxTokens: 'int',
  temperature: 'float',
  reasoningEffort: 'text',
  watchPort: 'int',
  rustLog: 'text',
  maxConcurrent: 'int',
  requestTimeoutSecs: 'int',
}

function backend() {
  return backends.find((b) => b.id === settings.llm) || { kind: 'none', models: [] }
}

function readField(id, type) {
  const el = $(id)
  if (type === 'bool') return el.checked
  if (type === 'int') return parseInt(el.value, 10) || 0
  if (type === 'float') return parseFloat(el.value) || 0
  return el.value
}

function writeField(id, type, value) {
  const el = $(id)
  if (!el) return
  if (type === 'bool') el.checked = Boolean(value)
  else el.value = value == null ? '' : value
}

async function persist(patch) {
  settings = await api.saveSettings(patch)
  if (running) {
    dirtyWhileRunning = true
    $('restart').hidden = false
  }
}

/// One shared toast for whichever screen is showing — Play/Restart failures
/// alike, so an error never depends on which screen happened to trigger it.
function showErrors(errors) {
  const box = $('errors')
  const list = errors || []
  box.hidden = list.length === 0
  box.textContent = list.map((e) => `• ${e}`).join('\n')
}

/// Drives `body[data-screen]`, the single source of which screen is visible.
function setScreen(name) {
  document.body.dataset.screen = name
}

function renderClassOptions() {
  $('characterClass').innerHTML = classes.map((c) => `<option value="${c.id}">${c.id}</option>`).join('')
  $('characterClass').value = settings.characterClass
  renderGenderOptions()
}

function renderGenderOptions() {
  const cls = classes.find((c) => c.id === settings.characterClass)
  const allowed = cls ? cls.genders : ['male', 'female']
  $('gender').innerHTML = allowed.map((g) => `<option value="${g}">${g}</option>`).join('')
  if (!allowed.includes(settings.gender)) settings.gender = allowed[0]
  $('gender').value = settings.gender
  $('genderHint').textContent =
    allowed.length === 1
      ? `Only a ${allowed[0]} model exists for ${settings.characterClass}.`
      : 'Changing gender on an existing character recreates it — level and items reset.'
}

function renderBackend() {
  const b = backend()
  $('model').value = settings.models[settings.llm] || ''
  $('modelList').innerHTML = (b.models || []).map((m) => `<option value="${m}"></option>`).join('')
  $('apiKey').value = (settings.llm === 'openrouter' ? settings.openrouterKey : settings.openaiKey) || ''

  for (const el of document.querySelectorAll('[data-for]')) {
    const want = el.dataset.for
    const visible =
      want === 'http'
        ? b.kind === 'http'
        : want === 'openai'
          ? settings.llm === 'openai'
          : want === settings.authMode
    el.hidden = !visible
  }

  $('model').closest('label').hidden = b.kind === 'none'
  $('backendHint').textContent =
    b.kind === 'cli'
      ? `Runs the ${b.id} CLI on this machine, under your own login and quota. It must work in a terminal first.`
      : b.kind === 'http'
        ? 'The key is stored encrypted by the OS and handed to the agent as an environment variable, never written to config.toml.'
        : 'No LLM: the character connects and idles.'
}

/// Once running is false, whatever screen is showing bounces back to
/// wherever restarting makes sense — Character, for a session that was
/// already playing.
function setStatus(state) {
  running = state.running
  $('dot').className = `dot${running ? ' on' : ''}`
  $('status').textContent = running ? `running (pid ${state.pid})` : 'stopped'
  $('restart').hidden = !(running && dirtyWhileRunning)
  if (!running) {
    const frame = $('frame')
    frame.hidden = true
    frame.removeAttribute('src')
    delete frame.dataset.url
    sceneUrl = null
    $('placeholder').hidden = false
    setVitals(null)
  }
}

function appendLog(item) {
  const pre = $('log')
  const line = document.createElement('div')
  line.className = `line-${item.stream}`
  line.textContent = item.line
  pre.appendChild(line)
  while (pre.childElementCount > 600) pre.removeChild(pre.firstChild)
  if ($('autoscroll').checked) pre.scrollTop = pre.scrollHeight
}

/// The Login screen's three mutually exclusive states (ADR 0001): checking
/// the cache, a cached credential to continue with, or a fresh device code.
function showLoginState(state) {
  $('loginChecking').hidden = state !== 'checking'
  $('loginCode').hidden = state !== 'code'
}

function showDeviceCode(code) {
  if (!code || !code.code) return
  $('banner-code').textContent = code.code
  $('loginCode').dataset.url = code.url || 'https://www.google.com/device'
  showLoginState('code')
}

/// Runs the device flow (main process does the actual OAuth, ADR 0001).
/// Guarded by `signInGeneration` so a poll abandoned via "Start over" can't
/// resolve later and yank the screen back to Character.
async function beginSignIn() {
  showLoginState('checking')
  const generation = ++signInGeneration
  const res = await api.authSignIn()
  if (generation !== signInGeneration) return
  await afterSignIn(res)
}

async function enterLoginScreen() {
  if (workflow) return workflow.continueWithProfile(selectedProfileId)
  setScreen('login')
  showLoginState('checking')
}

/// Shared tail of Continue and the device flow: land on Character with
/// whatever the pre-flight session found, or stay put on failure — a protocol
/// mismatch (ADR 0002) or a refused sign-in alike. Login is the first screen
/// now, so there is nowhere behind it to bounce to: leave the error in the
/// toast and offer whichever sign-in action can still be retried, rather than
/// the "checking…" pulse it was mid-way through.
async function afterSignIn(res) {
  if (!res.ok) {
    showErrors([res.error])
    setScreen('login')
    // A cached credential still has Continue to retry the pre-flight with.
    // Without one, every sub-state is a lie — the code just failed and
    // "checking…" would pulse forever — so hide all three and leave the card
    // on "Start over", which is outside them and always works.
    showLoginState((await api.authStatus()).signedIn ? 'continue' : null)
    return
  }
  characters = res.characters
  updateCreateVisibility()
  if (characters.length) {
    // Already has a character worth playing — pick it and wait for Play,
    // rather than making a returning player re-choose every time.
    selectCharacter(characters[0].id)
    setCharacterTab('pick')
  } else {
    selectedCharacterId = null
    renderCharacterList()
    await persist({ characterName: '' })
    updatePlayEnabled()
    setCharacterTab('create')
  }
  setScreen('character')
}

function profileById(id) {
  return profiles.find((profile) => profile.id === id)
}

function renderProfiles() {
  const box = $('profileList')
  box.innerHTML = ''
  for (const profile of profiles) {
    const button = document.createElement('button')
    button.className = `profile-row${profile.id === selectedProfileId ? ' on' : ''}`
    const status = profile.validation?.ok
      ? 'Verified'
      : profile.validation?.error
        ? profile.validation.error
        : 'Not verified'
    button.innerHTML = '<span class="profile-name"></span><span class="profile-meta"></span>'
    button.querySelector('.profile-name').textContent =
      `${profile.name}${profile.kind === 'builtin' ? ' · Built-in' : ''}`
    button.querySelector('.profile-meta').textContent = `${profile.serverUrl} · ${status}`
    button.addEventListener('click', () => {
      selectedProfileId = profile.id
      renderProfiles()
      renderProfileStatus()
    })
    box.appendChild(button)
  }
  const selected = profileById(selectedProfileId)
  $('profileEdit').disabled = !selected || selected.kind === 'builtin'
  $('profileDelete').disabled = !selected || selected.kind === 'builtin'
  $('profileContinue').disabled = !selected
  $('profileTest').disabled = !selected
}

function renderProfileStatus() {
  const profile = profileById(selectedProfileId)
  if (!profile) {
    $('profileStatus').textContent = ''
    return
  }
  $('profileStatus').textContent = profile.validation?.ok
    ? `Last verified ${new Date(profile.validation.checkedAt).toLocaleString()}`
    : profile.validation?.error || 'This profile has not been verified yet.'
}

function openProfileEditor(profile = null) {
  editingProfileId = profile?.id || null
  $('profileName').value = profile?.name || ''
  $('profileServer').value = profile?.serverUrl || ''
  $('profileTerrain').value = profile?.terrainOrigin || ''
  $('profileClientId').value = profile?.googleClientId || ''
  $('profileClientSecret').value = ''
  $('profileEditor').hidden = false
}

function closeProfileEditor() {
  editingProfileId = null
  $('profileEditor').hidden = true
}

function renderWorkflow(state) {
  profiles = state.profiles || profiles
  selectedProfileId = state.selectedProfileId || selectedProfileId
  showErrors(state.errors)
  if (state.screen === 'server') {
    setScreen('server')
    renderProfiles()
    renderProfileStatus()
  } else if (state.screen === 'oauth') {
    setScreen('login')
    showLoginState('checking')
  } else if (state.screen === 'character') {
    characters = state.characters
    $('accountName').textContent = state.accountName || ''
    selectedCharacterId = null
    renderCharacterList()
    updateCreateVisibility()
    setCharacterTab(characters.length ? 'pick' : 'create')
    setScreen('character')
  } else if (state.screen === 'game') {
    setScreen('game')
    applyPlayState(state.session)
  }
}

/// The four Character-screen tabs. "connection" isn't a panel of its own —
/// it opens the settings modal shared with Login/Game — so it never becomes
/// the active tab.
function setCharacterTab(name) {
  for (const btn of document.querySelectorAll('#characterTabs .tab')) {
    btn.classList.toggle('on', btn.dataset.tab === name)
  }
  for (const panel of document.querySelectorAll('[data-tab-panel]')) {
    panel.hidden = panel.dataset.tabPanel !== name
  }
}

function bindCharacterTabs() {
  for (const btn of document.querySelectorAll('#characterTabs .tab')) {
    btn.addEventListener('click', () => {
      if (btn.dataset.tab === 'connection') {
        openSettings()
        return
      }
      setCharacterTab(btn.dataset.tab)
    })
  }
}

/// One row per existing character (max 3, server-enforced): pick it, or
/// delete it. Pre-flight session fully owns this CRUD (ADR 0001) — nothing
/// here talks to agent-client.
function renderCharacterList() {
  const box = $('characterList')
  box.innerHTML = ''
  if (!characters.length) {
    const p = document.createElement('p')
    p.className = 'character-empty'
    p.textContent = 'No characters yet — create one from the Create a new character tab.'
    box.appendChild(p)
    return
  }
  for (const c of characters) {
    const row = document.createElement('div')
    row.className = `character-row${c.id === selectedCharacterId ? ' on' : ''}`
    row.innerHTML =
      '<span class="character-info"><span class="character-name"></span><span class="character-meta"></span></span>' +
      '<button type="button" class="ghost small">Delete</button>'
    row.querySelector('.character-name').textContent = c.name
    const last = profileById(selectedProfileId)?.lastSession?.characterId === c.id ? ' · Last played' : ''
    row.querySelector('.character-meta').textContent = `${c.class} · ${c.gender} · Lv.${c.level}${last}`
    row.querySelector('.character-info').addEventListener('click', () => enterCharacter(c))
    row.querySelector('button').addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      deleteCharacterRow(c.id, c.name)
    })
    box.appendChild(row)
  }
}

async function enterCharacter(character) {
  selectedCharacterId = character.id
  await persist({ characterName: character.name })
  await loadInstancePrompt()
  await loadCoords()
  await loadBagLabels()
  await workflow.chooseCharacter(character.id)
}

function selectCharacter(id) {
  selectedCharacterId = id
  renderCharacterList()
  const chosen = characters.find((c) => c.id === id)
  persist({ characterName: chosen ? chosen.name : '' })
  updatePlayEnabled()
  void loadInstancePrompt()
  void loadCoords()
  void loadBagLabels()
}

/// Individual personality for whichever character is selected — reloaded on
/// every switch, since it's per-character rather than shared like
/// user_prompt.txt.
async function loadInstancePrompt() {
  const name = settings.characterName
  $('instanceCharacterName').textContent = name || 'this character'
  if (!name) {
    $('instanceText').value = ''
    $('instanceFile').textContent = ''
    return
  }
  $('instanceText').value = await api.getInstancePrompt(selectedCharacterId, name)
  $('instanceFile').textContent = `Personality for this server and character`
}

let memoryPollTimer = null

/// Read-only view of the agent's own memory.txt — reloaded on every switch,
/// same per-character scoping as the personality prompt.
async function loadMemory() {
  const name = settings.characterName
  $('memoryCharacterName').textContent = name || 'this character'
  if (!name) {
    $('memoryText').textContent = ''
    $('memoryEmpty').hidden = true
    return
  }
  const text = await api.getMemory(name)
  $('memoryText').textContent = text
  $('memoryEmpty').hidden = Boolean(text && text.trim())
}

/// The agent can append to memory.txt mid-session, so the tab polls while
/// it's the one actually showing — stopped the moment it isn't (see
/// setPersonalitySubtab/bindRail) to avoid needless file reads otherwise.
function startMemoryPolling() {
  void loadMemory()
  stopMemoryPolling()
  memoryPollTimer = setInterval(loadMemory, 3000)
}

function stopMemoryPolling() {
  if (memoryPollTimer) clearInterval(memoryPollTimer)
  memoryPollTimer = null
}

function setPersonalitySubtab(name) {
  for (const btn of document.querySelectorAll('#personalityTabs .tab')) {
    btn.classList.toggle('on', btn.dataset.subtab === name)
  }
  for (const panel of document.querySelectorAll('[data-subtab-panel]')) {
    panel.hidden = panel.dataset.subtabPanel !== name
  }
  if (name === 'memory') startMemoryPolling()
  else stopMemoryPolling()
}

function bindPersonalityTabs() {
  for (const btn of document.querySelectorAll('#personalityTabs .tab')) {
    btn.addEventListener('click', () => setPersonalitySubtab(btn.dataset.subtab))
  }
}

const BUILTIN_COORDS = [
  { name: 'Rica', x: -1473.8, y: 1.1, z: 4735.5 },
  { name: 'Fishing spot', x: -1501.6, y: 0.3, z: 4732.3 },
  { name: 'Old Crypt', x: -1450, y: 0.7, z: 4720 },
  { name: 'Orc Warren', x: -1616, y: 1.05, z: 4918 },
]
let customCoords = []

/// Player-saved coordinates, reloaded on every character switch — scoped the
/// same way as the personality text (per connection profile + character).
async function loadCoords() {
  customCoords = selectedCharacterId ? await api.listCoordinates(selectedCharacterId) : []
  renderCoords()
}

function coordRow(coord, removable) {
  const row = document.createElement('div')
  row.className = 'coord-row'
  const go = document.createElement('button')
  go.type = 'button'
  go.className = 'coord-go'
  go.textContent = `${coord.name} (${coord.x}, ${coord.y}, ${coord.z})`
  go.addEventListener('click', () => sendCoordDirective(coord))
  row.appendChild(go)
  if (removable) {
    const del = document.createElement('button')
    del.type = 'button'
    del.className = 'ghost small coord-delete'
    del.textContent = '×'
    del.title = 'Remove'
    del.addEventListener('click', async () => {
      const res = await api.deleteCoordinate(selectedCharacterId, coord.id)
      if (res.ok) {
        customCoords = res.list
        renderCoords()
      }
    })
    row.appendChild(del)
  }
  return row
}

function renderCoords() {
  const box = $('coordsList')
  box.innerHTML = ''
  for (const coord of BUILTIN_COORDS) box.appendChild(coordRow(coord, false))
  for (const coord of customCoords) box.appendChild(coordRow(coord, true))
}

/// Same directive pipe as the Dispatch input (ADR 0003): a best-effort nudge
/// for the NPC's next turn, so a clicked spot gets the same You/Agent
/// feedback as anything typed by hand.
async function sendCoordDirective(coord) {
  const text = `Go to ${coord.name} (${coord.x}, ${coord.y}, ${coord.z}).`
  const res = await api.sendDirective(text)
  if (!res.ok) {
    showErrors([res.error])
    return
  }
  trackDirective(text)
}

async function deleteCharacterRow(id, name) {
  if (!(await confirmAction(`Delete ${name}? This cannot be undone.`))) return
  const res = await api.deleteCharacter(id)
  if (!res.ok) {
    showErrors([res.error])
    return
  }
  characters = characters.filter((c) => c.id !== id)
  if (selectedCharacterId === id) {
    selectedCharacterId = null
    await persist({ characterName: '' })
  }
  renderCharacterList()
  updateCreateVisibility()
  updatePlayEnabled()
  if (!characters.length) setCharacterTab('create')
}

/// Server enforces the cap (server/src/auth.rs) — this just keeps the tab
/// from being offered once it would only produce that refusal.
function updateCreateVisibility() {
  const atMax = characters.length >= 3
  const tab = document.querySelector('#characterTabs [data-tab="create"]')
  tab.hidden = atMax
  if (atMax && tab.classList.contains('on')) setCharacterTab('pick')
}

function updatePlayEnabled() {
  // Character activation itself enters the game; there is no separate Play.
}

function applyView() {
  if (!sceneUrl) return
  const frame = $('frame')
  if (frame.dataset.url !== sceneUrl) {
    frame.dataset.url = sceneUrl
    frame.src = sceneUrl
  }
  frame.hidden = false
  $('placeholder').hidden = true
}

/// Back to the "nothing to watch" card, carrying why. The scene is the only
/// view now, so a scene that cannot open has nothing to fall back to — saying
/// so is better than an empty frame.
function showViewProblem(message) {
  $('viewHint').textContent = message
  const frame = $('frame')
  frame.hidden = true
  frame.removeAttribute('src')
  delete frame.dataset.url
  $('placeholder').hidden = false
}

/// Every slot the game has (shared/src/inventory.rs EquipSlot), head down and
/// then hands, so the list reads like a character sheet and an empty slot is
/// as visible as a filled one — "no chest armour" is worth seeing.
const WORN_SLOTS = [
  ['head', 'Head'],
  ['neck', 'Neck'],
  ['ear', 'Ear'],
  ['chest', 'Chest'],
  ['belt', 'Belt'],
  ['pants', 'Pants'],
  ['boots', 'Boots'],
  ['main_hand', 'Main hand'],
  ['off_hand', 'Off hand'],
  ['ring', 'Ring'],
  ['ring_left', 'Ring (left)'],
]

/// One label per parsed AgentAction (agent-client/src/driver/action.rs),
/// shown next to the clock in the gamebar header.
function actionLabel(action) {
  if (!action || typeof action !== 'object') return ''
  switch (action.type) {
    case 'say': {
      const msg = String(action.message ?? '')
      return `Say "${msg.length > 24 ? `${msg.slice(0, 24)}…` : msg}"`
    }
    case 'attack': {
      const id = action.monster_id ?? action.target ?? action.id ?? '?'
      return `Attack→${monsterNames.get(id) ?? id}`
    }
    case 'move':
      if (action.target) return `Move→${action.target}`
      if (action.x != null || action.z != null) {
        const x = action.x != null ? Math.round(action.x) : '?'
        const z = action.z != null ? Math.round(action.z) : '?'
        return `Move→(${x}, ${z})`
      }
      if (action.direction) return `Move→${action.direction}${action.distance != null ? ` ${action.distance}m` : ''}`
      if (action.depth != null) return `Move→floor ${action.depth}`
      return 'Move'
    case 'respawn':
      return 'Respawn'
    case 'fish':
      return 'Fish'
    case 'stop_fishing':
      return 'Stop fishing'
    case 'offer_deal':
      return `Offer→${action.item ?? '?'}${action.player ? ` to ${action.player}` : ''}`
    case 'open_trade':
      return `Trade→${action.player ?? '?'}`
    case 'party_invite':
      return `Invite→${action.player ?? '?'}`
    case 'party_accept':
      return 'Accept party'
    case 'party_decline':
      return 'Decline party'
    case 'party_leave':
      return 'Leave party'
    case 'use':
      return `Use→${action.item ?? '?'}`
    case 'pickup':
      return `Pickup→${action.item ?? '?'}`
    case 'sell':
      return `Sell→${action.item ?? '?'}`
    case 'buy':
      return `Buy→${action.item ?? '?'}`
    case 'drop':
      return `Drop→${action.item ?? '?'}`
    case 'buyback':
      return `Buyback→${action.item ?? '?'}`
    case 'break_prop':
      return `Break→prop ${action.prop_id ?? action.id ?? '?'}`
    case 'open_chest':
      return action.chest ? `Open chest→${action.chest}` : 'Open chest'
    case 'reroll':
      return 'Reroll'
    case 'wait':
      return 'Wait'
    default:
      return action.type ? String(action.type) : ''
  }
}

const ACTION_TOAST_TTL_MS = 7000
const ACTION_TOAST_FADE_MS = 400
const ACTION_TOAST_CAP = 10

/// A serialized signature of whichever `actions` array the last setVitals
/// call already toasted. main.js resends the same actions every poll tick
/// until a new turn lands — but each send crosses the main/renderer IPC
/// boundary, which structured-clones the payload, so the renderer never
/// receives the same array *instance* twice even when nothing changed.
/// Comparing content instead of identity is what actually tells a genuinely
/// new turn apart from the same stale value arriving again.
let lastToastedActionsSignature = null

/// Toast element -> its pending fade/remove timers, so a repeat of the same
/// action (see pushActionToast) can cancel and restart them instead of
/// leaving the old ones to fire early on a toast that just got reused.
const actionToastTimers = new Map()

function scheduleToastRemoval(el) {
  const prev = actionToastTimers.get(el)
  if (prev) {
    clearTimeout(prev.fadeTimer)
    clearTimeout(prev.removeTimer)
  }
  el.classList.remove('out')
  actionToastTimers.set(el, {
    fadeTimer: setTimeout(() => el.classList.add('out'), ACTION_TOAST_TTL_MS - ACTION_TOAST_FADE_MS),
    removeTimer: setTimeout(() => {
      actionToastTimers.delete(el)
      el.remove()
    }, ACTION_TOAST_TTL_MS),
  })
}

/// A repeated action (e.g. "Move→north" every turn while walking) collapses
/// into the most recent toast instead of stacking a new one — otherwise a
/// long walk reads as a wall of identical notifications.
function pushActionToast(text) {
  const box = $('actionToasts')
  const last = box.lastElementChild
  if (last && last.dataset.label === text) {
    const count = Number(last.dataset.count) + 1
    last.dataset.count = String(count)
    last.textContent = `${text} ×${count}`
    scheduleToastRemoval(last)
    return
  }
  const el = document.createElement('div')
  el.className = 'action-toast'
  el.textContent = text
  el.dataset.label = text
  el.dataset.count = '1'
  box.appendChild(el)
  while (box.childElementCount > ACTION_TOAST_CAP) box.removeChild(box.firstChild)
  scheduleToastRemoval(el)
}

function pushActionToasts(actions) {
  const signature = Array.isArray(actions) ? JSON.stringify(actions) : ''
  if (signature === lastToastedActionsSignature) return
  lastToastedActionsSignature = signature
  if (!Array.isArray(actions)) return
  for (const action of actions) {
    const label = actionLabel(action)
    if (label) pushActionToast(label)
  }
}

function clearActionToasts() {
  for (const { fadeTimer, removeTimer } of actionToastTimers.values()) {
    clearTimeout(fadeTimer)
    clearTimeout(removeTimer)
  }
  actionToastTimers.clear()
  $('actionToasts').innerHTML = ''
  lastToastedActionsSignature = null
}

function setVitals(v) {
  if (!v || !v.self) {
    $('vitals').textContent = ''
    clearActionToasts()
    renderBag([])
    renderWorn({})
    return
  }
  const s = v.self
  const clock =
    v.time && v.time.hour != null
      ? ` · ${String(v.time.hour).padStart(2, '0')}:${String(v.time.minute ?? 0).padStart(2, '0')}`
      : ''
  const gold = v.gold == null ? '' : ` · ${v.gold}g`
  $('vitals').textContent = `${s.name} Lv.${s.level} · ${s.health}/${s.max_health} HP${gold}${clock}`
  pushActionToasts(v.actions)
  renderBag(v.bag)
}

/// item_def_id is a snake_case identifier ("healing_potion") — turn it into
/// words, with the enchant level prefixed the way the game names enchanted
/// gear ("+2 Iron Sword").
function itemLabel(id, enchant) {
  const words = id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  return enchant ? `+${enchant} ${words}` : words
}

/// What the character has on, slot by slot, from the relay's view of the
/// server's inventory frames (src/proxy.js) — the agent's own panel API
/// reports the bag but never the gear.
function renderWorn(worn) {
  const box = $('wornList')
  box.innerHTML = ''
  const equipped = worn && typeof worn === 'object' ? worn : {}
  let count = 0
  for (const [slot, label] of WORN_SLOTS) {
    const item = equipped[slot]
    if (item) count++
    const row = document.createElement('div')
    row.className = item ? 'worn-row' : 'worn-row worn-bare'
    const name = document.createElement('span')
    name.className = 'worn-slot'
    name.textContent = label
    const value = document.createElement('span')
    value.className = 'worn-item'
    value.textContent = item ? itemLabel(item.itemDefId, item.enchant) : '—'
    row.append(name, value)
    box.appendChild(row)
  }
  // The slot list itself is always drawn, so the hint speaks to the gear:
  // an all-empty sheet is the one case worth saying out loud.
  $('wornEmpty').hidden = count > 0
}

/// Sellable/dropable marks for the currently loaded character — the source
/// of truth is main.js's labels.json; instance.txt's own copy is just a
/// rendering of this for agent-client to read (see config.composeInstanceText).
/// Staged in-memory as Sets of "item_def_id#enchant" bag-row keys and only
/// written to disk when Apply labels is clicked.
let stagedLabels = { sellable: new Set(), dropable: new Set() }
/// The bag rows from the most recent render, kept around so the Apply
/// button can check for enchant collisions without re-deriving them.
let currentBagRows = []

async function loadBagLabels() {
  stagedLabels = { sellable: new Set(), dropable: new Set() }
  $('bagLabelsStatus').textContent = ''
  if (!selectedCharacterId) return
  const saved = await api.getBagLabels(selectedCharacterId)
  stagedLabels = {
    sellable: new Set(saved.sellable || []),
    dropable: new Set(saved.dropable || []),
  }
}

function bagMarkCheckbox(letter, title, checked, onChange) {
  const label = document.createElement('label')
  label.className = 'bag-mark'
  label.title = title
  const input = document.createElement('input')
  input.type = 'checkbox'
  input.checked = checked
  input.addEventListener('change', () => onChange(input.checked))
  const span = document.createElement('span')
  span.textContent = letter
  label.append(input, span)
  return label
}

/// agent-client keeps each pickup as its own bag instance rather than
/// merging stacks, so raw entries repeat the same item many times over —
/// grouped by item + enchant here into one line each, with a total count.
/// Each row carries its own Sellable/Dropable checkboxes, staged into
/// stagedLabels until Apply labels commits them.
function renderBag(bag) {
  const box = $('bagList')
  box.innerHTML = ''
  const grouped = new Map()
  for (const item of bag || []) {
    const key = `${item.item_def_id}#${item.enchant || 0}`
    grouped.set(key, (grouped.get(key) || 0) + (item.quantity || 1))
  }
  const rows = [...grouped.entries()]
    .map(([key, quantity]) => {
      const [id, enchant] = key.split('#')
      return { key, id, enchant: Number(enchant), label: itemLabel(id, Number(enchant)), quantity }
    })
    .sort((a, b) => a.label.localeCompare(b.label))
  currentBagRows = rows

  $('bagEmpty').hidden = rows.length > 0
  $('bagLabelsSubmit').hidden = rows.length === 0
  for (const row of rows) {
    const el = document.createElement('div')
    el.className = 'bag-row'

    const marks = document.createElement('span')
    marks.className = 'bag-marks'
    marks.append(
      bagMarkCheckbox('S', 'Sellable', stagedLabels.sellable.has(row.key), (checked) => {
        if (checked) stagedLabels.sellable.add(row.key)
        else stagedLabels.sellable.delete(row.key)
      }),
      bagMarkCheckbox('D', 'Dropable', stagedLabels.dropable.has(row.key), (checked) => {
        if (checked) stagedLabels.dropable.add(row.key)
        else stagedLabels.dropable.delete(row.key)
      }),
    )

    const name = document.createElement('span')
    name.className = 'bag-name'
    name.textContent = row.label
    const qty = document.createElement('span')
    qty.className = 'bag-qty'
    qty.textContent = `×${row.quantity}`
    el.append(marks, name, qty)
    box.appendChild(el)
  }
}

/// sell/drop actions take only an item_def_id, with no way to say which
/// enchant level they mean (agent-client driver/action.rs) — so marking one
/// enchant variant while carrying another is ambiguous: the model could act
/// on either. Surfaced as one consolidated warning per Apply click, listing
/// every item_def_id in the staged batch that has more than one enchant
/// variant in the current bag.
function enchantCollisions() {
  const enchantsById = new Map()
  for (const row of currentBagRows) {
    if (!enchantsById.has(row.id)) enchantsById.set(row.id, new Set())
    enchantsById.get(row.id).add(row.enchant)
  }
  const ids = new Set()
  for (const key of [...stagedLabels.sellable, ...stagedLabels.dropable]) {
    const id = key.split('#')[0]
    if ((enchantsById.get(id)?.size || 0) > 1) ids.add(id)
  }
  return [...ids].map((id) => itemLabel(id)).sort()
}

async function submitBagLabels() {
  if (!selectedCharacterId) return
  const collisions = enchantCollisions()
  if (collisions.length) {
    const proceed = await confirmAction(
      `${collisions.join(', ')} — you carry more than one enchant level, and sell/drop can't tell them apart. ` +
        'The agent might act on the wrong one. Apply labels anyway?',
      'Apply anyway',
    )
    if (!proceed) return
  }
  const res = await api.saveBagLabels(selectedCharacterId, settings.characterName, {
    sellable: [...stagedLabels.sellable],
    dropable: [...stagedLabels.dropable],
  })
  $('bagLabelsStatus').textContent = res.ok ? 'Labels applied.' : res.error || 'Failed to apply labels.'
}

/// One entry per LLM turn or game event. Prompts are long, so they start
/// clipped and open on click — except the agent's own replies, which are the
/// reason the panel exists and are short enough to read in full. Click still
/// collapses them.
function appendFeed(items) {
  const box = $('feed')
  for (const item of items) {
    if (item.k === 'llm-prompt') learnMonsterNames(item.m)

    const el = document.createElement('div')
    el.className = `feed-item k-${item.k}`
    if (item.k === 'llm-response') el.classList.add('open')
    el.dataset.kind = item.k
    el.hidden = feedHidden.has(item.k)

    const head = document.createElement('div')
    head.className = 'feed-head'
    const timing = item.d == null ? '' : ` · ${(item.d / 1000).toFixed(1)}s`
    head.textContent = `${new Date(item.t).toLocaleTimeString()} ${item.k}${timing}`

    const body = document.createElement('div')
    body.className = 'feed-body'
    body.textContent = item.m

    el.appendChild(head)
    el.appendChild(body)
    el.addEventListener('click', () => el.classList.toggle('open'))
    box.appendChild(el)

    // Best-effort, not guaranteed (ADR 0003): show the agent's next turn
    // right next to the directive, so a player can see whether it landed
    // instead of trusting it silently worked.
    if (pendingDirective && (item.k === 'llm-response' || item.k === 'llm-error') && item.t >= pendingDirective.sentAt) {
      $('directiveReply').textContent = item.m
      pendingDirective = null
    }
  }
  while (box.childElementCount > 400) box.removeChild(box.firstChild)
  // Same contract as the Log pane's Follow: while it is on, the newest turn is
  // always in view, and turning it off holds the scroll position so a turn can
  // be read while the agent keeps going.
  if ($('feedFollow').checked) box.scrollTop = box.scrollHeight
}

/// Records what was sent so the reply (above) can be matched back to it.
function trackDirective(text) {
  pendingDirective = { text, sentAt: Date.now() }
  $('directiveSent').textContent = text
  $('directiveReply').textContent = 'waiting…'
  $('directiveLog').hidden = false
  // The one deliberate animation moment (see style.css) — a brief ember
  // pulse marking that word was actually sent.
  const panel = $('directivePanel')
  panel.classList.add('sent')
  setTimeout(() => panel.classList.remove('sent'), 900)
}

function renderFeedFilters() {
  const box = $('feedFilters')
  box.innerHTML = ''
  for (const kind of FEED_KINDS) {
    const b = document.createElement('button')
    b.textContent = kind.replace('llm-', '')
    b.className = 'chip on'
    b.addEventListener('click', () => {
      const off = feedHidden.has(kind)
      if (off) feedHidden.delete(kind)
      else feedHidden.add(kind)
      b.classList.toggle('on', off)
      for (const el of document.querySelectorAll(`.feed-item[data-kind="${kind}"]`)) {
        el.hidden = feedHidden.has(kind)
      }
    })
    box.appendChild(b)
  }
}

function openSettings() {
  settingsSnapshot = structuredClone(settings)
  $('settingsModal').hidden = false
  settingsDirty = false
  $('settingsDirty').hidden = true
  syncCadenceControls()
}

function closeSettings() {
  if (settingsDirty && !window.confirm('Discard unapplied settings changes?')) return
  if (settingsDirty && settingsSnapshot) {
    settings = settingsSnapshot
    for (const [id, type] of Object.entries(FIELDS)) writeField(id, type, settings[id])
    renderClassOptions()
    renderBackend()
    syncCadenceControls()
  }
  settingsSnapshot = null
  settingsDirty = false
  $('settingsModal').hidden = true
}

const ACTIVE_CADENCES = [
  ['Very fast', 3],
  ['Fast', 5],
  ['Balanced', 10],
  ['Relaxed', 20],
  ['Economical', 30],
]
const IDLE_CADENCES = [
  ['Frequent', 30],
  ['Normal', 60],
  ['Occasional', 300],
  ['Rare', 900],
  ['Minimum', 3600],
]

function nearestCadenceIndex(options, seconds) {
  let best = 0
  for (let i = 1; i < options.length; i++) {
    if (Math.abs(options[i][1] - seconds) < Math.abs(options[best][1] - seconds)) best = i
  }
  return best
}

function syncCadenceControls() {
  $('activeCadence').value = nearestCadenceIndex(ACTIVE_CADENCES, settings.minIntervalSecs)
  $('idleCadence').value = nearestCadenceIndex(IDLE_CADENCES, settings.idleIntervalSecs)
  renderCadenceLabels()
}

function renderCadenceLabels() {
  const active = ACTIVE_CADENCES[Number($('activeCadence').value)]
  const idle = IDLE_CADENCES[Number($('idleCadence').value)]
  $('activeCadenceLabel').textContent = `${active[0]} · ${active[1]} seconds`
  $('activeCadenceHint').textContent = `At most about ${(60 / active[1]).toFixed(1)} calls/minute while active.`
  $('idleCadenceLabel').textContent =
    `${idle[0]} · ${idle[1] >= 60 ? `${idle[1] / 60} minute${idle[1] === 60 ? '' : 's'}` : `${idle[1]} seconds`}`
  $('idleCadenceHint').textContent = `At most about ${(60 / idle[1]).toFixed(2)} calls/minute while quiet.`
}

function setSettingsTab(name) {
  for (const button of document.querySelectorAll('[data-settings-tab]')) {
    button.classList.toggle('on', button.dataset.settingsTab === name)
  }
  for (const panel of document.querySelectorAll('[data-settings-panel]')) {
    panel.hidden = panel.dataset.settingsPanel !== name
  }
}

function applyPlayState(state) {
  if (!state) return
  playMode = state.mode || playMode
  document.body.dataset.mode = playMode
  $('modeManual').classList.toggle('on', playMode === 'manual')
  $('modeAi').classList.toggle('on', playMode === 'ai')
  $('modeManual').disabled = state.phase === 'switching'
  $('modeAi').disabled = state.phase === 'switching'
  clearInterval(retryCountdownTimer)
  retryCountdownTimer = null
  const startedAt = Date.now()
  const renderStatus = () => {
    const remaining = state.retryInMs
      ? Math.max(0, state.retryInMs - (Date.now() - startedAt))
      : 0
    const retry = remaining ? ` · retry in ${Math.ceil(remaining / 1000)}s` : ''
    $('status').textContent = `${state.phase}${retry}`
  }
  renderStatus()
  if (state.retryInMs) retryCountdownTimer = setInterval(renderStatus, 250)
  if (state.notice) showErrors([state.notice])
  if (state.viewUrl) {
    sceneUrl = state.viewUrl
    applyView()
  }
}

/// A destructive action's one guard: resolves true only if Delete is
/// clicked, false for Cancel or dismissing any other way.
function confirmAction(message, okLabel = 'Delete') {
  return new Promise((resolve) => {
    $('confirmMessage').textContent = message
    $('confirmOk').textContent = okLabel
    $('confirmModal').hidden = false
    const finish = (result) => {
      $('confirmModal').hidden = true
      $('confirmOk').removeEventListener('click', onOk)
      $('confirmCancel').removeEventListener('click', onCancel)
      resolve(result)
    }
    const onOk = () => finish(true)
    const onCancel = () => finish(false)
    $('confirmOk').addEventListener('click', onOk)
    $('confirmCancel').addEventListener('click', onCancel)
  })
}

/// Rail icons open a slide-over drawer; clicking the open one again closes it.
function bindRail() {
  const titles = { worn: 'Equipment', bag: 'Bag', prompt: 'Personality & Memory', thoughts: 'Thoughts', log: 'Log', coords: 'Coordinates' }
  for (const btn of document.querySelectorAll('.rail [data-drawer]')) {
    btn.addEventListener('click', () => {
      const kind = btn.dataset.drawer
      const drawer = $('drawer')
      const isOpenSame = !drawer.hidden && drawer.dataset.kind === kind
      for (const other of document.querySelectorAll('.rail [data-drawer]')) other.classList.remove('on')
      if (isOpenSame) {
        drawer.hidden = true
        drawer.dataset.kind = ''
        stopMemoryPolling()
        return
      }
      drawer.hidden = false
      drawer.dataset.kind = kind
      btn.classList.add('on')
      $('drawerTitle').textContent = titles[kind]
      for (const panel of document.querySelectorAll('[data-drawer-panel]')) {
        panel.hidden = panel.dataset.drawerPanel !== kind
      }
      // Always land on Personality, not wherever Memory's polling was left
      // off — simpler than tracking whether it's safe to resume polling.
      if (kind === 'prompt') setPersonalitySubtab('personality')
      else stopMemoryPolling()
    })
  }
  $('drawerClose').addEventListener('click', () => {
    $('drawer').hidden = true
    stopMemoryPolling()
    for (const other of document.querySelectorAll('.rail [data-drawer]')) other.classList.remove('on')
  })
}

function bindFields() {
  for (const [id, type] of Object.entries(FIELDS)) {
    const el = $(id)
    if (!el) continue
    el.addEventListener('change', () => {
      const value = readField(id, type)
      settings[id] = value
      settingsDirty = true
      $('settingsDirty').hidden = false
      if (id === 'characterClass') {
        renderGenderOptions()
      }
      if (id === 'llm') renderBackend()
    })
  }

  $('model').addEventListener('change', () => {
    settings.models[settings.llm] = $('model').value
    settingsDirty = true
    $('settingsDirty').hidden = false
  })
  $('apiKey').addEventListener('change', () => {
    const key = settings.llm === 'openrouter' ? 'openrouterKey' : 'openaiKey'
    settings[key] = $('apiKey').value
    settingsDirty = true
    $('settingsDirty').hidden = false
  })

  $('activeCadence').addEventListener('input', () => {
    settings.minIntervalSecs = ACTIVE_CADENCES[Number($('activeCadence').value)][1]
    $('minIntervalSecs').value = settings.minIntervalSecs
    settingsDirty = true
    $('settingsDirty').hidden = false
    renderCadenceLabels()
  })
  $('idleCadence').addEventListener('input', () => {
    settings.idleIntervalSecs = IDLE_CADENCES[Number($('idleCadence').value)][1]
    $('idleIntervalSecs').value = settings.idleIntervalSecs
    settingsDirty = true
    $('settingsDirty').hidden = false
    renderCadenceLabels()
  })
  for (const button of document.querySelectorAll('[data-settings-tab]')) {
    button.addEventListener('click', () => setSettingsTab(button.dataset.settingsTab))
  }
}

/// A validation error naming a field on a tab that isn't showing is useless —
/// land on Create, the tab most validation failures (no character chosen, a
/// class/gender mismatch) actually belong to. LLM/connection errors still
/// read fine from the shared toast regardless of which tab is up.
function expandCharacterSections() {
  setCharacterTab('create')
}

function bindActions() {
  $('profileContinue').addEventListener('click', () => workflow.continueWithProfile(selectedProfileId))
  $('profileTest').addEventListener('click', async () => {
    $('profileTest').disabled = true
    const result = await api.testProfile(selectedProfileId)
    $('profileTest').disabled = false
    profiles = await api.listProfiles()
    renderProfiles()
    renderProfileStatus()
    if (!result.ok) showErrors([result.error])
  })
  $('profileNew').addEventListener('click', () => openProfileEditor())
  $('profileEdit').addEventListener('click', () => {
    const profile = profileById(selectedProfileId)
    if (profile?.kind === 'custom') openProfileEditor(profile)
  })
  $('profileDuplicate').addEventListener('click', async () => {
    const profile = await api.duplicateProfile(selectedProfileId)
    profiles = await api.listProfiles()
    selectedProfileId = profile.id
    renderProfiles()
    openProfileEditor(profile)
  })
  $('profileDelete').addEventListener('click', async () => {
    const profile = profileById(selectedProfileId)
    if (!profile || profile.kind === 'builtin') return
    if (!(await confirmAction(`Delete ${profile.name} and its saved Google login?`))) return
    profiles = await api.deleteProfile(profile.id)
    selectedProfileId = profiles.find((candidate) => candidate.selected)?.id || profiles[0]?.id
    renderProfiles()
    renderProfileStatus()
  })
  $('profileCancel').addEventListener('click', closeProfileEditor)
  $('profileSave').addEventListener('click', async () => {
    const input = {
      name: $('profileName').value.trim(),
      serverUrl: $('profileServer').value.trim(),
      terrainOrigin: $('profileTerrain').value.trim(),
      googleClientId: $('profileClientId').value.trim(),
    }
    if ($('profileClientSecret').value) input.googleClientSecret = $('profileClientSecret').value
    try {
      const profile = editingProfileId
        ? await api.updateProfile(editingProfileId, input)
        : await api.createProfile(input)
      profiles = await api.listProfiles()
      selectedProfileId = profile.id
      closeProfileEditor()
      renderProfiles()
      renderProfileStatus()
    } catch (err) {
      showErrors([err.message])
    }
  })

  $('loginCancel').addEventListener('click', () => workflow.cancelOAuth())

  $('switchAccount').addEventListener('click', async () => {
    await api.signOut()
    await workflow.continueWithProfile(selectedProfileId)
  })

  $('createCharacter').addEventListener('click', async () => {
    showErrors([])
    const name = $('newCharacterName').value.trim()
    if (!name) {
      showErrors(['Character name is required'])
      return
    }
    $('createCharacter').disabled = true
    const res = await api.createCharacter(name, settings.characterClass, settings.gender)
    $('createCharacter').disabled = false
    if (!res.ok) {
      showErrors([res.error])
      return
    }
    characters.push(res.character)
    $('newCharacterName').value = ''
    renderCharacterList()
    updateCreateVisibility()
    await enterCharacter(res.character)
  })

  $('directiveForm').addEventListener('submit', async (e) => {
    e.preventDefault()
    const input = $('directiveInput')
    const text = input.value.trim()
    if (!text) return
    input.value = ''
    const res = await api.sendDirective(text)
    if (!res.ok) {
      showErrors([res.error])
      return
    }
    trackDirective(text)
  })

  $('coordsForm').addEventListener('submit', async (e) => {
    e.preventDefault()
    const name = $('coordName').value.trim()
    const x = Number($('coordX').value)
    const y = Number($('coordY').value)
    const z = Number($('coordZ').value)
    if (!name || !selectedCharacterId || [x, y, z].some(Number.isNaN)) return
    const res = await api.addCoordinate(selectedCharacterId, { name, x, y, z })
    if (!res.ok) {
      showErrors([res.error])
      return
    }
    customCoords = res.list
    renderCoords()
    e.target.reset()
  })

  $('saveInstance').addEventListener('click', async () => {
    if (!settings.characterName) return
    showErrors([])
    const res = await api.saveInstancePrompt(
      selectedCharacterId,
      settings.characterName,
      $('instanceText').value,
    )
    if (!running) {
      $('instanceFile').textContent = `Saved to ${res.file}`
      return
    }
    // Only prompt customization here — restarting takes agent-client with
    // it, same as clicking Apply & restart, just without the extra click.
    $('instanceFile').textContent = 'Saved — applying…'
    const restarted = await api.restart()
    if (!restarted.ok) {
      showErrors(restarted.errors)
      $('instanceFile').textContent = `Saved to ${res.file} — restart failed`
      return
    }
    dirtyWhileRunning = false
    setStatus(restarted.status)
    $('instanceFile').textContent = `Saved to ${res.file} — applied`
  })

  $('bagLabelsSubmit').addEventListener('click', () => void submitBagLabels())

  $('restart').addEventListener('click', async () => {
    showErrors([])
    const res = await api.restart()
    if (!res.ok) showErrors(res.errors)
    else {
      dirtyWhileRunning = false
      setStatus(res.status)
    }
  })

  $('banner-open').addEventListener('click', () =>
    api.open($('loginCode').dataset.url || 'https://www.google.com/device'),
  )
  $('banner-copy').addEventListener('click', () => navigator.clipboard.writeText($('banner-code').textContent))

  $('clearLog').addEventListener('click', () => ($('log').textContent = ''))
  $('clearFeed').addEventListener('click', () => ($('feed').textContent = ''))

  // A 3D client left running all night grows; dropping the frame frees it
  // without disturbing the agent, which lives in another process entirely.
  $('reloadView').addEventListener('click', () => {
    const frame = $('frame')
    const url = frame.dataset.url
    if (!url) return
    frame.removeAttribute('src')
    delete frame.dataset.url
    requestAnimationFrame(() => applyView())
  })

  $('modeManual').addEventListener('click', async () => {
    const result = await api.switchMode('manual')
    if (!result.ok) showErrors([result.error])
    else applyPlayState(result.session)
  })
  $('modeAi').addEventListener('click', async () => {
    const result = await api.switchMode('ai')
    if (!result.ok) showErrors([result.error])
    else applyPlayState(result.session)
  })
  $('modeSettings').addEventListener('click', openSettings)
  $('changeCharacter').addEventListener('click', async () => {
    if (!(await confirmAction('Leave this session and choose another character?', 'Leave'))) return
    await api.leavePlay('character')
    setScreen('character')
  })
  $('changeServer').addEventListener('click', async () => {
    if (!(await confirmAction('Leave this session and choose another server?', 'Leave'))) return
    await api.leavePlay('server')
    await workflow.start()
  })
  $('settingsApply').addEventListener('click', async () => {
    showErrors([])
    $('settingsApply').disabled = true
    $('settingsApply').textContent = 'Validating…'
    const applied = await api.applySettings(settings)
    $('settingsApply').disabled = false
    $('settingsApply').textContent = 'Apply'
    if (!applied.ok) {
      showErrors(applied.errors)
      return
    }
    settings = applied.settings
    settingsDirty = false
    $('settingsDirty').hidden = true
    if (playMode === 'ai' && running) {
      const result = await api.restart()
      if (!result.ok) {
        showErrors(result.errors)
        return
      }
    }
    closeSettings()
  })

  $('openSettingsFromGame').addEventListener('click', openSettings)
  $('settingsClose').addEventListener('click', closeSettings)
}

window.addEventListener('message', (event) => {
  if (event.source !== $('frame').contentWindow) return
  if (event.data?.type === 'openmmo-manual-ready') void api.manualReady()
  if (event.data?.type === 'openmmo-manual-error') {
    void api.manualReady(event.data.error || 'Manual client could not enter the world')
  }
})

async function init() {
  const info = await api.info()
  settings = info.settings
  backends = info.backends
  classes = info.classes

  $('llm').innerHTML = backends
    .filter((backend) => backend.kind !== 'none')
    .map((backend) => `<option value="${backend.id}">${backend.label}</option>`)
    .join('')
  for (const [id, type] of Object.entries(FIELDS)) writeField(id, type, settings[id])
  renderClassOptions()
  renderBackend()

  for (const item of info.log) appendLog(item)

  setStatus(info.status)
  // A window reopened onto a session that never stopped gets no `view:ready`
  // of its own — that fires once, when the agent's watch server comes up — so
  // ask for the scene rather than sitting on the "nothing to watch" card.
  if (info.status.running) void api.openView()

  bindFields()
  bindActions()
  bindRail()
  bindCharacterTabs()
  bindPersonalityTabs()

  renderFeedFilters()
  renderWorn({})
  renderCoords()
  api.onLog(appendLog)
  api.onFeed(appendFeed)
  api.onVitals(setVitals)
  api.onWorn(renderWorn)
  api.onViewReady((urls) => {
    if (urls && urls.scene) sceneUrl = urls.scene
    if (urls && urls.mode) {
      playMode = urls.mode
      document.body.dataset.mode = playMode
    }
    applyView()
  })
  api.onViewStop(() => {
    sceneUrl = null
    const frame = $('frame')
    frame.hidden = true
    frame.removeAttribute('src')
    delete frame.dataset.url
    $('placeholder').hidden = false
  })
  api.onViewMemory((mb) => {
    $('mem').textContent = mb ? `${mb} MB` : ''
    $('mem').classList.toggle('high', mb > 1500)
  })
  api.onViewError(showViewProblem)
  api.onState(setStatus)
  api.onDeviceCode(showDeviceCode)
  api.onFatal((message) => showErrors([message]))
  api.onPlayState(applyPlayState)
  // The watch server coming up is what says the session is live; main.js sends
  // the scene URL off the same event.
  api.onWatchReady(() => {
    if (running) setScreen('game')
  })

  workflow = new window.AppWorkflow(
    {
      listProfiles: api.listProfiles,
      selectProfile: api.selectProfile,
      testProfile: api.testProfile,
      authStatus: api.authStatus,
      authContinue: api.authContinue,
      authSignIn: api.authSignIn,
      authCancel: api.authCancel,
      enterCharacter: api.enterCharacter,
    },
    renderWorkflow,
  )
  await workflow.start()
}

init()
