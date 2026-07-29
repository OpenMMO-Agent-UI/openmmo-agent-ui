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

const FEED_KINDS = [
  'llm-prompt',
  'llm-response',
  'llm-error',
  'chat',
  'combat',
  'trade',
  'system',
]

/// Plain settings fields; `model` and `apiKey` are per-backend and handled apart.
const FIELDS = {
  characterName: 'text',
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
  showErrors(await api.validate({}))
}

function showErrors(errors) {
  const box = $('errors')
  box.hidden = !errors || errors.length === 0
  box.textContent = (errors || []).map((e) => `• ${e}`).join('\n')
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

function setStatus(state) {
  running = state.running
  $('dot').className = `dot${running ? ' on' : ''}`
  $('status').textContent = running ? `running (pid ${state.pid})` : 'stopped'
  $('start').hidden = running
  $('stop').hidden = !running
  $('restart').hidden = !(running && dirtyWhileRunning)
  if (!running) {
    const frame = $('frame')
    frame.hidden = true
    frame.removeAttribute('src')
    delete frame.dataset.url
    viewUrls = { scene: null, panel: null }
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

function showDeviceCode(code) {
  if (!code || !code.code) return
  $('banner').hidden = false
  $('banner-code').textContent = code.code
  $('banner').dataset.url = code.url || 'https://www.google.com/device'
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
      ? 'Signed in — Start connects without asking again.'
      : 'Not signed in — Start shows a code to enter in your browser.')
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
  }
  while (box.childElementCount > 400) box.removeChild(box.firstChild)
  if (atBottom) box.scrollTop = box.scrollHeight
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

function bindTabs() {
  for (const tab of document.querySelectorAll('#tabs button')) {
    tab.addEventListener('click', () => {
      for (const other of document.querySelectorAll('#tabs button')) other.classList.remove('on')
      tab.classList.add('on')
      for (const panel of document.querySelectorAll('section[data-panel]')) {
        panel.hidden = panel.dataset.panel !== tab.dataset.tab
      }
    })
  }
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

function bindActions() {
  $('start').addEventListener('click', async () => {
    showErrors([])
    const res = await api.start()
    if (!res.ok) showErrors(res.errors)
    else {
      dirtyWhileRunning = false
      setStatus(res.status)
    }
  })

  $('stop').addEventListener('click', async () => {
    const res = await api.stop()
    setStatus(res.status)
  })

  $('restart').addEventListener('click', async () => {
    showErrors([])
    $('banner').hidden = true
    const res = await api.restart()
    if (!res.ok) showErrors(res.errors)
    else {
      dirtyWhileRunning = false
      setStatus(res.status)
    }
  })

  $('banner-open').addEventListener('click', () =>
    api.open($('banner').dataset.url || 'https://www.google.com/device'),
  )
  $('banner-copy').addEventListener('click', () => navigator.clipboard.writeText($('banner-code').textContent))
  $('banner-close').addEventListener('click', () => ($('banner').hidden = true))

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
      ? 'Signed out and stopped the agent. Press Start to sign in again.'
      : 'Signed out. Press Start to sign in again.')
  })

  $('pickBinary').addEventListener('click', async () => {
    const picked = await api.pickBinary()
    if (picked) {
      settings.binaryPath = picked
      $('binaryInfo').textContent = `Binary: ${picked}`
    }
  })

  $('openAgentDir').addEventListener('click', () => {
    const dir = $('openAgentDir').dataset.path
    if (dir) api.open(dir)
  })
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

  setAuthState(info.signedIn)
  $('binaryInfo').textContent = info.binary
    ? `Binary: ${info.binary}`
    : `No agent-client binary found. Build it with "cargo build --release -p agent-client", or choose one below.`
  $('openAgentDir').dataset.path = info.agentDir

  const prompt = await api.getPrompt()
  $('promptText').value = prompt.text
  $('preset').innerHTML = prompt.presets.map((p) => `<option value="${p}">${p}</option>`).join('')
  $('promptFile').textContent = prompt.file

  for (const item of info.log) appendLog(item)
  setStatus(info.status)
  if (info.status.deviceCode) showDeviceCode(info.status.deviceCode)
  if (info.status.watchUrl) showWatch(info.status.watchUrl)
  showErrors(await api.validate({}))

  bindTabs()
  bindFields()
  bindActions()

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
  api.onWatchReady(showWatch)
}

init()
