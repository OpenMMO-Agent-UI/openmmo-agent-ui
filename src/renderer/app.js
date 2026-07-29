'use strict'

const api = window.agentApp
const $ = (id) => document.getElementById(id)

let settings = null
let backends = []
let classes = []
let running = false
let dirtyWhileRunning = false
let viewUrls = { scene: null, panel: null }
let activeView = 'scene'
const feedHidden = new Set()

// Pre-flight session state (ADR 0001): the character list fetched at sign-in,
// and which one is chosen for this Play. Bumped on every sign-in attempt so
// a stale device-flow poll (abandoned via "choose a different binary") can't
// resolve later and yank the screen back.
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
  server: 'text',
  terrain: 'text',
  authMode: 'text',
  googleClientId: 'text',
  googleClientSecret: 'text',
  npcAccount: 'text',
  watchPort: 'int',
  rustLog: 'text',
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
  if (name === 'character') {
    $('characterRecap').textContent = settings.characterName ? `Playing as ${settings.characterName}` : 'OpenMMO'
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
/// wherever restarting makes sense — Character for a session that was
/// already playing, Binary for one that died before ever signing in.
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
    viewUrls = { scene: null, panel: null }
    $('placeholder').hidden = false
    setVitals(null)
    if (document.body.dataset.screen === 'game') setScreen('character')
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
  $('loginContinue').hidden = state !== 'continue'
  $('loginCode').hidden = state !== 'code'
}

function showDeviceCode(code) {
  if (!code || !code.code) return
  $('banner-code').textContent = code.code
  $('loginCode').dataset.url = code.url || 'https://www.google.com/device'
  showLoginState('code')
}

/// Runs the device flow (main process does the actual OAuth, ADR 0001).
/// Guarded by `signInGeneration` so a poll abandoned via "choose a different
/// binary" can't resolve later and yank the screen back to Character.
async function beginSignIn() {
  showLoginState('checking')
  const generation = ++signInGeneration
  const res = await api.authSignIn()
  if (generation !== signInGeneration) return
  await afterSignIn(res)
}

async function enterLoginScreen() {
  setScreen('login')
  showLoginState('checking')
  const status = await api.authStatus()
  if (status.signedIn) showLoginState('continue')
  else await beginSignIn()
}

/// Shared tail of Continue and the device flow: land on Character with
/// whatever the pre-flight session found, or bounce back to Binary on
/// failure — a protocol mismatch (ADR 0002) or a refused sign-in alike.
async function afterSignIn(res) {
  if (!res.ok) {
    showErrors([res.error])
    setScreen('binary')
    return
  }
  characters = res.characters
  selectedCharacterId = null
  await persist({ characterName: '' })
  renderCharacterList()
  updateCreateVisibility()
  updatePlayEnabled()
  setScreen('character')
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
    p.textContent = 'No characters yet — create one below.'
    box.appendChild(p)
    return
  }
  for (const c of characters) {
    const row = document.createElement('label')
    row.className = `character-row${c.id === selectedCharacterId ? ' on' : ''}`
    row.innerHTML =
      '<input type="radio" name="characterPick" />' +
      '<span class="character-info"><span class="character-name"></span><span class="character-meta"></span></span>' +
      '<button type="button" class="ghost small">Delete</button>'
    row.querySelector('input').checked = c.id === selectedCharacterId
    row.querySelector('.character-name').textContent = c.name
    row.querySelector('.character-meta').textContent = `${c.class} · ${c.gender} · Lv.${c.level}`
    row.querySelector('input').addEventListener('change', () => selectCharacter(c.id))
    row.querySelector('button').addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      deleteCharacterRow(c.id, c.name)
    })
    box.appendChild(row)
  }
}

function selectCharacter(id) {
  selectedCharacterId = id
  renderCharacterList()
  const chosen = characters.find((c) => c.id === id)
  persist({ characterName: chosen ? chosen.name : '' })
  updatePlayEnabled()
}

async function deleteCharacterRow(id, name) {
  if (!window.confirm(`Delete ${name}? This cannot be undone.`)) return
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
}

/// Server enforces the cap (server/src/auth.rs) — this just keeps the form
/// from being offered once it would only produce that refusal.
function updateCreateVisibility() {
  const atMax = characters.length >= 3
  $('toggleNewCharacter').hidden = atMax
  if (atMax) $('newCharacterFields').hidden = true
}

function updatePlayEnabled() {
  $('play').disabled = !selectedCharacterId
}

function showWatch(url) {
  if (!viewUrls.panel) viewUrls.panel = url
  if (activeView === 'panel') applyView()
}

function applyView() {
  const url = viewUrls[activeView]
  if (!url) return
  const frame = $('frame')
  if (frame.dataset.url !== url) {
    frame.dataset.url = url
    frame.src = url
  }
  frame.hidden = false
  $('placeholder').hidden = true
}

/// `note` overrides the resting description right after a sign-out, so the
/// click has visible consequences instead of a silently changed file.
function setAuthState(isSignedIn, note) {
  $('authState').textContent =
    note ??
    (isSignedIn
      ? 'Signed in — Play connects without asking again.'
      : 'Not signed in — Play shows a code to enter in your browser.')
  $('signOut').disabled = !isSignedIn
}

function setVitals(v) {
  if (!v || !v.self) {
    $('vitals').textContent = ''
    return
  }
  const s = v.self
  const clock =
    v.time && v.time.hour != null
      ? ` · ${String(v.time.hour).padStart(2, '0')}:${String(v.time.minute ?? 0).padStart(2, '0')}`
      : ''
  const gold = v.gold == null ? '' : ` · ${v.gold}g`
  $('vitals').textContent = `${s.name} Lv.${s.level} · ${s.health}/${s.max_health} HP${gold}${clock}`
}

/// One entry per LLM turn or game event. Prompts are long, so they start
/// clipped and open on click.
function appendFeed(items) {
  const box = $('feed')
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40
  for (const item of items) {
    const el = document.createElement('div')
    el.className = `feed-item k-${item.k}`
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
  if (atBottom) box.scrollTop = box.scrollHeight
}

/// Records what was sent so the reply (above) can be matched back to it.
function trackDirective(text) {
  pendingDirective = { text, sentAt: Date.now() }
  $('directiveSent').textContent = text
  $('directiveReply').textContent = 'waiting…'
  $('directiveLog').hidden = false
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
  $('settingsModal').hidden = false
}

function closeSettings() {
  $('settingsModal').hidden = true
}

/// Rail icons open a slide-over drawer; clicking the open one again closes it.
function bindRail() {
  const titles = { thoughts: 'Thoughts', log: 'Log' }
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
    el.addEventListener('change', async () => {
      const value = readField(id, type)
      await persist({ [id]: value })
      if (id === 'characterClass') {
        renderGenderOptions()
        await persist({ gender: settings.gender })
      }
      if (id === 'llm') renderBackend()
      if (id === 'authMode') renderBackend()
    })
  }

  $('model').addEventListener('change', () => persist({ models: { [settings.llm]: $('model').value } }))
  $('apiKey').addEventListener('change', () => {
    const key = settings.llm === 'openrouter' ? 'openrouterKey' : 'openaiKey'
    persist({ [key]: $('apiKey').value })
  })
}

/// Toggles a collapsed section open/closed, flipping the trigger button's
/// label between its closed and open text.
function bindExpander(buttonId, fieldsId, closedLabel, openLabel) {
  $(buttonId).addEventListener('click', () => {
    const fields = $(fieldsId)
    fields.hidden = !fields.hidden
    $(buttonId).textContent = fields.hidden ? closedLabel : openLabel
  })
}

/// A validation error naming a field inside a collapsed section is useless
/// if the section is still closed — open both before showing it.
function expandCharacterSections() {
  $('newCharacterFields').hidden = false
  $('toggleNewCharacter').textContent = 'Hide new character'
  $('llmSettingsFields').hidden = false
  $('toggleLlmSettings').textContent = 'Hide LLM & behavior settings'
}

/// Actually spawns the resolved binary (see agent.js's probeBinary) rather
/// than just checking a file exists, so a picked .app bundle or wrong-arch
/// build fails here instead of as a bare "spawn ENOEXEC" during Play.
async function checkBinaryAndReport() {
  const result = await api.checkBinary()
  $('binaryInfo').textContent = result.ok
    ? `Binary: ${result.path}`
    : result.path
      ? `Binary: ${result.path} — ${result.error}`
      : result.error
  return result.ok
}

function bindActions() {
  // No agent process to stop — sign-in never starts one (ADR 0001) — just
  // abandon any in-flight device-flow poll and back out.
  $('loginCancel').addEventListener('click', () => {
    signInGeneration++
    setScreen('binary')
  })

  $('continueSignIn').addEventListener('click', async () => {
    $('continueSignIn').disabled = true
    const res = await api.authContinue()
    $('continueSignIn').disabled = false
    await afterSignIn(res)
  })

  $('switchAccount').addEventListener('click', async () => {
    await api.signOut()
    await beginSignIn()
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
    $('newCharacterFields').hidden = true
    $('toggleNewCharacter').textContent = 'Create a new character'
    renderCharacterList()
    updateCreateVisibility()
    selectCharacter(res.character.id)
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

  bindExpander('toggleNewCharacter', 'newCharacterFields', 'Create a new character', 'Hide new character')
  bindExpander('toggleLlmSettings', 'llmSettingsFields', 'LLM & behavior settings', 'Hide LLM & behavior settings')
  bindExpander('togglePersona', 'personaFields', 'Customize prompt', 'Hide prompt')

  $('play').addEventListener('click', async () => {
    showErrors([])
    // Binary's Continue may already have started the agent to get the
    // device code moving — Play only needs to (re)start it if settings
    // changed since, otherwise the already-connected session is right here.
    let res
    if (!running) res = await api.start()
    else if (dirtyWhileRunning) res = await api.restart()
    else {
      setScreen('game')
      return
    }
    if (!res.ok) {
      expandCharacterSections()
      showErrors(res.errors)
    } else {
      dirtyWhileRunning = false
      setScreen('game')
      setStatus(res.status)
    }
  })

  $('stop').addEventListener('click', async () => {
    const res = await api.stop()
    setStatus(res.status)
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

  for (const btn of document.querySelectorAll('.viewtoggle button')) {
    btn.addEventListener('click', () => {
      for (const other of document.querySelectorAll('.viewtoggle button')) other.classList.remove('on')
      btn.classList.add('on')
      activeView = btn.dataset.view
      applyView()
    })
  }

  $('loadPreset').addEventListener('click', async () => {
    const res = await api.loadPreset($('preset').value)
    if (res.ok) $('promptText').value = res.text
  })

  $('savePrompt').addEventListener('click', async () => {
    const res = await api.savePrompt($('promptText').value)
    $('promptFile').textContent = `Saved to ${res.file}${running ? ' — restart to apply' : ''}`
    if (running) {
      dirtyWhileRunning = true
      $('restart').hidden = false
    }
  })

  $('showSystem').addEventListener('click', async () => {
    const pre = $('systemPrompt')
    if (!pre.hidden) {
      pre.hidden = true
      return
    }
    pre.textContent = await api.systemPrompt()
    pre.hidden = false
  })

  $('signOut').addEventListener('click', async () => {
    const res = await api.signOut()
    if (!res.removed) {
      setAuthState(false, 'Nothing to sign out of — no credential is stored.')
      return
    }
    setAuthState(false, res.wasRunning
      ? 'Signed out and stopped the agent. Play to sign in again.'
      : 'Signed out. Play to sign in again.')
  })

  $('pickBinary').addEventListener('click', async () => {
    const picked = await api.pickBinary()
    if (picked) {
      settings.binaryPath = picked
      await checkBinaryAndReport()
    }
  })

  $('binaryContinue').addEventListener('click', async () => {
    showErrors([])
    $('binaryContinue').disabled = true
    $('binaryContinue').textContent = 'Checking…'
    const ok = await checkBinaryAndReport()
    $('binaryContinue').disabled = false
    $('binaryContinue').textContent = 'Continue'
    if (!ok) {
      showErrors(['agent-client is not runnable — choose a different binary.'])
      return
    }
    // A session already running (app restarted mid-play) skips straight to
    // Game; anything else goes through sign-in — agent-client itself never
    // starts until a character is chosen and Play is pressed (ADR 0001).
    if (running) {
      setScreen('game')
      return
    }
    await enterLoginScreen()
  })
  $('openBinaryFromSettings').addEventListener('click', () => {
    closeSettings()
    setScreen('binary')
  })

  $('openSettingsFromLogin').addEventListener('click', openSettings)
  $('openSettingsFromCharacter').addEventListener('click', openSettings)
  $('openSettingsFromGame').addEventListener('click', openSettings)
  $('settingsClose').addEventListener('click', closeSettings)
}

async function init() {
  const info = await api.info()
  settings = info.settings
  backends = info.backends
  classes = info.classes

  $('llm').innerHTML = backends.map((b) => `<option value="${b.id}">${b.label}</option>`).join('')
  for (const [id, type] of Object.entries(FIELDS)) writeField(id, type, settings[id])
  renderClassOptions()
  renderBackend()

  setAuthState((await api.authStatus()).signedIn)
  $('binaryInfo').textContent = info.binary
    ? `Binary: ${info.binary}`
    : `No agent-client binary found. Build it with "cargo build --release -p agent-client", or choose one below.`

  const prompt = await api.getPrompt()
  $('promptText').value = prompt.text
  $('preset').innerHTML = prompt.presets.map((p) => `<option value="${p}">${p}</option>`).join('')
  $('promptFile').textContent = prompt.file

  for (const item of info.log) appendLog(item)

  // Decide the starting screen before setStatus's auto-bounce-to-character
  // rule can fire on a false `running` that just means "freshly opened."
  // A session already running (app restarted mid-play) skips straight past
  // the binary/login/character gates; anything else starts at Binary.
  setScreen(info.status.running ? 'game' : 'binary')

  setStatus(info.status)
  if (info.status.watchUrl) showWatch(info.status.watchUrl)

  bindFields()
  bindActions()
  bindRail()

  renderFeedFilters()
  api.onLog(appendLog)
  api.onFeed(appendFeed)
  api.onVitals(setVitals)
  api.onViewReady((urls) => {
    viewUrls = { ...viewUrls, ...urls }
    applyView()
  })
  api.onViewMemory((mb) => {
    $('mem').textContent = mb ? `${mb} MB` : ''
    $('mem').classList.toggle('high', mb > 1500)
  })
  api.onViewError((message) => {
    $('viewHint').textContent = message
    activeView = 'panel'
    for (const b of document.querySelectorAll('.viewtoggle button')) {
      b.classList.toggle('on', b.dataset.view === 'panel')
    }
    applyView()
  })
  api.onState(setStatus)
  api.onDeviceCode(showDeviceCode)
  api.onFatal((message) => showErrors([message]))
  api.onWatchReady((url) => {
    showWatch(url)
    if (running) setScreen('game')
  })
}

init()
