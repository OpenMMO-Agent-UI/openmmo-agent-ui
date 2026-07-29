'use strict'

const api = window.agentApp
const $ = (id) => document.getElementById(id)

let settings = null
let backends = []
let classes = []
let running = false
let dirtyWhileRunning = false
/// The spectator scene's URL, once the relay is listening and the agent has a
/// session to mirror. One view, so one URL: there is nothing to switch between.
let sceneUrl = null
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
    sceneUrl = null
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
  $('instanceText').value = await api.getInstancePrompt(name)
  $('instanceFile').textContent = `data/npcs/${name}/instance.txt`
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
  $('play').disabled = !selectedCharacterId
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
  $('settingsModal').hidden = false
}

function closeSettings() {
  $('settingsModal').hidden = true
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
  const titles = { worn: 'Equipment', bag: 'Bag', thoughts: 'Thoughts', log: 'Log', prompt: 'Personality' }
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

/// A validation error naming a field on a tab that isn't showing is useless —
/// land on Create, the tab most validation failures (no character chosen, a
/// class/gender mismatch) actually belong to. LLM/connection errors still
/// read fine from the shared toast regardless of which tab is up.
function expandCharacterSections() {
  setCharacterTab('create')
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
    renderCharacterList()
    updateCreateVisibility()
    selectCharacter(res.character.id)
    setCharacterTab('pick')
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
    const res = await api.saveInstancePrompt(settings.characterName, $('instanceText').value)
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

  for (const item of info.log) appendLog(item)

  // Decide the starting screen before setStatus's auto-bounce-to-character
  // rule can fire on a false `running` that just means "freshly opened."
  // A session already running (app restarted mid-play) skips straight past
  // the binary/login/character gates; anything else starts at Binary.
  setScreen(info.status.running ? 'game' : 'binary')

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
    applyView()
  })
  api.onViewMemory((mb) => {
    $('mem').textContent = mb ? `${mb} MB` : ''
    $('mem').classList.toggle('high', mb > 1500)
  })
  api.onViewError(showViewProblem)
  api.onState(setStatus)
  api.onDeviceCode(showDeviceCode)
  api.onFatal((message) => showErrors([message]))
  // The watch server coming up is what says the session is live; main.js sends
  // the scene URL off the same event.
  api.onWatchReady(() => {
    if (running) setScreen('game')
  })
}

init()
