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
  await workflow.chooseCharacter(character.id)
}

function selectCharacter(id) {
  selectedCharacterId = id
  renderCharacterList()
  const chosen = characters.find((c) => c.id === id)
  persist({ characterName: chosen ? chosen.name : '' })
  updatePlayEnabled()
  void loadInstancePrompt()
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

function setVitals(v) {
  if (!v || !v.self) {
    $('vitals').textContent = ''
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

/// agent-client keeps each pickup as its own bag instance rather than
/// merging stacks, so raw entries repeat the same item many times over —
/// grouped by item + enchant here into one line each, with a total count.
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
      return { label: itemLabel(id, Number(enchant)), quantity }
    })
    .sort((a, b) => a.label.localeCompare(b.label))

  $('bagEmpty').hidden = rows.length > 0
  for (const row of rows) {
    const el = document.createElement('div')
    el.className = 'bag-row'
    const name = document.createElement('span')
    name.className = 'bag-name'
    name.textContent = row.label
    const qty = document.createElement('span')
    qty.className = 'bag-qty'
    qty.textContent = `×${row.quantity}`
    el.append(name, qty)
    box.appendChild(el)
  }
}

/// One entry per LLM turn or game event. Prompts are long, so they start
/// clipped and open on click — except the agent's own replies, which are the
/// reason the panel exists and are short enough to read in full. Click still
/// collapses them.
function appendFeed(items) {
  const box = $('feed')
  for (const item of items) {
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
  const titles = { worn: 'Equipment', bag: 'Bag', prompt: 'Personality', thoughts: 'Thoughts', log: 'Log' }
  for (const btn of document.querySelectorAll('.rail [data-drawer]')) {
    btn.addEventListener('click', () => {
      const kind = btn.dataset.drawer
      const drawer = $('drawer')
      const isOpenSame = !drawer.hidden && drawer.dataset.kind === kind
      for (const other of document.querySelectorAll('.rail [data-drawer]')) other.classList.remove('on')
      if (isOpenSame) {
        drawer.hidden = true
        drawer.dataset.kind = ''
        return
      }
      drawer.hidden = false
      drawer.dataset.kind = kind
      btn.classList.add('on')
      $('drawerTitle').textContent = titles[kind]
      for (const panel of document.querySelectorAll('[data-drawer-panel]')) {
        panel.hidden = panel.dataset.drawerPanel !== kind
      }
    })
  }
  $('drawerClose').addEventListener('click', () => {
    $('drawer').hidden = true
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

  renderFeedFilters()
  renderWorn({})
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
