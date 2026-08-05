'use strict'

import { $, showErrors, setScreen, confirmAction, readField, writeField } from './dom.js'
import * as actionToasts from './actionToasts.js'
import * as bagWorn from './bagWorn.js'
import * as dispatchBook from './dispatchBook.js'
import * as settingsPanel from './settingsPanel.js'

const api = window.agentApp

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

/// monster_id -> display name, learned from "Monster: kobold [m1045_5] HP
/// 5/5 ..." lines in the agent's own llm-prompt feed items (agent-client's
/// state.rs format_world_state) — the id is what actions echo back and the
/// server matches on, never the name, so labels need this lookup to show
/// something readable. Never cleared: a monster out of view in a later
/// prompt should still resolve for an action against it moments earlier.
const monsterNames = new Map()
const MONSTER_LINE_RE = /Monster:\s*(\S+)\s*\[([^\]]+)\]/g

/// Mirrors agent-client's shop_info::format_price and the fork's
/// splitGold/GoldAmount.svelte: 1g = 100s = 10,000c, smallest unit (copper)
/// in, omitting denominations that are zero (but always showing copper if
/// the whole amount is).
function formatGold(copper) {
  const total = Math.trunc(Math.abs(copper))
  const gold = Math.trunc(total / 10000)
  const silver = Math.trunc((total % 10000) / 100)
  const bronze = total % 100
  const parts = []
  if (gold > 0) parts.push(`${gold}g`)
  if (silver > 0) parts.push(`${silver}s`)
  if (bronze > 0 || parts.length === 0) parts.push(`${bronze}c`)
  return `${copper < 0 ? '-' : ''}${parts.join(' ')}`
}

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

async function persist(patch) {
  settings = await api.saveSettings(patch)
  if (running) {
    dirtyWhileRunning = true
    $('restart').hidden = false
  }
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
  $('pauseAgent').textContent = running ? '⏸' : '▶'
  $('pauseAgent').title = running ? 'Pause the agent' : 'Resume the agent'
  $('pauseAgent').setAttribute('aria-label', $('pauseAgent').title)
  $('directiveInput').disabled = !running
  $('directiveInput').placeholder = running
    ? 'Send word to your character…'
    : 'Not running — nothing to dispatch to'
  $('directiveForm').querySelector('button[type="submit"]').disabled = !running
  if (!running) {
    const frame = $('frame')
    frame.hidden = true
    frame.removeAttribute('src')
    delete frame.dataset.url
    sceneUrl = null
    $('placeholder').hidden = false
    setVitals(null)
    settingsPanel.updateAudioAvailability()
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

/// The screen renderWorkflow last acted on — lets it tell a real transition
/// into 'character' (reset the pick list) apart from chooseCharacter's own
/// intermediate `{busy: true}` publish, which merges onto whatever screen
/// was already current and re-fires this same branch mid-entry. Without this,
/// that publish nulls the selectedCharacterId enterCharacter() just set,
/// moments before workflow.chooseCharacter() even resolves.
let lastRenderedScreen = null

function renderWorkflow(state) {
  profiles = state.profiles || profiles
  selectedProfileId = state.selectedProfileId || selectedProfileId
  showErrors(state.errors)
  const enteringScreen = state.screen !== lastRenderedScreen
  lastRenderedScreen = state.screen
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
    if (enteringScreen) selectedCharacterId = null
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
  await dispatchBook.loadCoords(selectedCharacterId)
  await dispatchBook.loadPresets(selectedCharacterId)
  await bagWorn.loadBagLabels(selectedCharacterId)
  await workflow.chooseCharacter(character.id)
}

function selectCharacter(id) {
  selectedCharacterId = id
  renderCharacterList()
  const chosen = characters.find((c) => c.id === id)
  persist({ characterName: chosen ? chosen.name : '' })
  updatePlayEnabled()
  void loadInstancePrompt()
  void dispatchBook.loadCoords(selectedCharacterId)
  void dispatchBook.loadPresets(selectedCharacterId)
  void bagWorn.loadBagLabels(selectedCharacterId)
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

function setActivityTab(name) {
  for (const btn of document.querySelectorAll('#activityTabs .tab')) {
    btn.classList.toggle('on', btn.dataset.activityTab === name)
  }
  for (const panel of document.querySelectorAll('[data-activity-panel]')) {
    panel.hidden = panel.dataset.activityPanel !== name
  }
}

function bindActivityTabs() {
  for (const btn of document.querySelectorAll('#activityTabs .tab')) {
    btn.addEventListener('click', () => setActivityTab(btn.dataset.activityTab))
  }
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
  settingsPanel.updateAudioAvailability()
}

/// Cached off the last vitals push so the Coordinates drawer's "Use current
/// position" button (bound in dispatchBook.bind) has something to read on
/// click — the agent-client's /api/state already carries this in
/// `self.position`, it just wasn't kept around anywhere before now.
let lastSelf = null

function setVitals(v) {
  if (!v || !v.self) {
    lastSelf = null
    $('coordUseCurrent').disabled = true
    $('vitals').textContent = ''
    actionToasts.clear()
    bagWorn.renderBag([])
    bagWorn.renderWorn({})
    return
  }
  const s = v.self
  lastSelf = s
  $('coordUseCurrent').disabled = !s.position
  const clock =
    v.time && v.time.hour != null
      ? ` · ${String(v.time.hour).padStart(2, '0')}:${String(v.time.minute ?? 0).padStart(2, '0')}`
      : ''
  const gold = v.gold == null ? '' : ` · ${formatGold(v.gold)}`
  const coords = s.position
    ? ` · (${s.position.x.toFixed(1)}, ${s.position.y.toFixed(1)}, ${s.position.z.toFixed(1)})`
    : ''
  $('vitals').textContent = `${s.name} Lv.${s.level} · ${s.health}/${s.max_health} HP${gold}${clock}${coords}`
  actionToasts.push(settings, v.actions, monsterNames)
  bagWorn.renderBag(v.bag)
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

    dispatchBook.consumeReply(item)
  }
  while (box.childElementCount > 400) box.removeChild(box.firstChild)
  // Same contract as the Log pane's Follow: while it is on, the newest turn is
  // always in view, and turning it off holds the scroll position so a turn can
  // be read while the agent keeps going.
  if ($('feedFollow').checked) box.scrollTop = box.scrollHeight
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
  settingsPanel.syncAll(settings)
}

function closeSettings() {
  if (settingsDirty && !window.confirm('Discard unapplied settings changes?')) return
  if (settingsDirty && settingsSnapshot) {
    settings = settingsSnapshot
    for (const [id, type] of Object.entries(FIELDS)) writeField(id, type, settings[id])
    renderClassOptions()
    renderBackend()
    settingsPanel.syncCadence(settings)
  }
  settingsSnapshot = null
  settingsDirty = false
  $('settingsModal').hidden = true
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
  $('pauseAgent').disabled = state.phase === 'switching'
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

/// Rail icons open a slide-over drawer; clicking the open one again closes it.
function bindRail() {
  const titles = { worn: 'Equipment', bag: 'Bag', prompt: 'Personality & Memory', activity: 'Activity', presets: 'Dispatch Presets', coords: 'Coordinates' }
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
      // Same reasoning as Personality/Memory: always land on Thoughts.
      if (kind === 'activity') setActivityTab('thoughts')
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

  for (const button of document.querySelectorAll('[data-settings-tab]')) {
    button.addEventListener('click', () => setSettingsTab(button.dataset.settingsTab))
  }
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

  $('saveInstance').addEventListener('click', async () => {
    if (!settings.characterName) return
    showErrors([])
    const res = await api.saveInstancePrompt(
      selectedCharacterId,
      settings.characterName,
      $('instanceText').value,
    )
    if (!res.ok) {
      $('instanceFile').textContent = res.error || 'Save failed'
      return
    }
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

  $('bagLabelsSubmit').addEventListener('click', () =>
    void bagWorn.submitBagLabels(selectedCharacterId, settings.characterName),
  )

  $('restart').addEventListener('click', async () => {
    showErrors([])
    const res = await api.restart()
    if (!res.ok) showErrors(res.errors)
    else {
      dirtyWhileRunning = false
      setStatus(res.status)
    }
  })

  // Pause stops agent-client outright (not a mode switch) so personality,
  // bag labels, and dispatch presets can be edited without it racing a save.
  // Resuming reuses the same start path as Apply & restart — any personality
  // edit made while paused just applies on the way back up.
  $('pauseAgent').addEventListener('click', async () => {
    showErrors([])
    $('pauseAgent').disabled = true
    const res = running ? await api.stop() : await api.restart()
    $('pauseAgent').disabled = false
    if (!res.ok) showErrors(res.errors)
    else setStatus(res.status)
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

// The game client's audio settings live in its iframe's own origin —
// every (re)load starts it fresh from its own localStorage, so re-push our
// side's preference each time rather than only on the Settings modal.
$('frame').addEventListener('load', () => {
  settingsPanel.updateAudioAvailability()
  settingsPanel.sendAudioToView(settings)
})

/// Shared by toast look/timing and audio: both take effect immediately and
/// save on every change — unlike LLM/Agent, there is nothing here for Apply
/// & validate to check or restart agent-client over, so staging them behind
/// that button would just add a click for a change that's purely cosmetic.
async function persistImmediateSetting(patch) {
  settings = await api.saveSettings(patch)
}

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
  actionToasts.applyToastCssVars(settings)

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
  bindActivityTabs()
  dispatchBook.bind({ getLastSelf: () => lastSelf })
  settingsPanel.bind({
    getSettings: () => settings,
    onCadenceChange: (patch) => {
      settings = { ...settings, ...patch }
      settingsDirty = true
      $('settingsDirty').hidden = false
    },
    onImmediateChange: (patch) => {
      settings = { ...settings, ...patch }
      void persistImmediateSetting(patch)
    },
  })

  renderFeedFilters()
  bagWorn.renderWorn({})
  dispatchBook.renderCoords()
  dispatchBook.renderPresets()
  api.onLog(appendLog)
  api.onFeed(appendFeed)
  api.onVitals(setVitals)
  api.onWorn(bagWorn.renderWorn)
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
    settingsPanel.updateAudioAvailability()
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
