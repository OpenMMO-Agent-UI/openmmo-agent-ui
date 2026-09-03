'use strict'

import { $, showErrors, setScreen, confirmAction, readField, writeField, isAnswered } from './dom.js'
import { attributeCells, dutyState } from './duty.js'
import * as actionToasts from './actionToasts.js'
import * as bagWorn from './bagWorn.js'
import * as settingsPanel from './settingsPanel.js'
import * as signInFlow from './signInFlow.js'
import * as updateStatus from './updateStatus.js'
import { t, setDictionary, applyI18n } from './i18n.js'

const api = window.agentApp

/// Where the external links in the session menu land. Kept next to `api`
/// so a future page move is a one-line change.
const SUPPORT_URL = 'https://ko-fi.com/dakywang'
const GITHUB_URL = 'https://github.com/OpenMMO-Agent-UI/openmmo-agent-ui'
const WIKI_URL = 'https://openmmo-agent-ui.github.io/openmmo-agent-wiki/en/'
const DISCORD_URL = 'https://discord.gg/FxeV7nNzZ'

let settings = null
let backends = []
let classes = []
let running = false
let dirtyWhileRunning = false
let playMode = 'ai'
let settingsDirty = false
let retryCountdownTimer = null
/// The play session's own phase and retry deadline, kept here because the
/// header's state word is written from them *and* from whether the agent
/// process is up — see duty.js for why that had to become one writer.
let sessionPhase = 'stopped'
let retryAt = 0
let settingsSnapshot = null
/// Whatever had focus when Settings opened (the rail button, the Character
/// screen's link), so closing hands focus back instead of dropping it on
/// <body> and stranding keyboard users at the top of the document.
let settingsOpener = null
/// The spectator scene's URL, once the relay is listening and the agent has a
/// session to mirror. One view, so one URL: there is nothing to switch between.
let sceneUrl = null
const feedHidden = new Set()

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

/// What each kind is called in the panel. The filter chips said "prompt" while
/// the turn they filtered said "llm-prompt", so the same thing had two names —
/// one of them the wire format's.
const FEED_LABELS = {
  'llm-prompt': 'Prompt',
  'llm-response': 'Reply',
  'llm-error': 'Error',
  chat: 'Chat',
  combat: 'Combat',
  trade: 'Trade',
  system: 'System',
}

/// Plain settings fields; `characterName` (Login screen), `model` and
/// `apiKey` (per-backend) are handled apart from this generic map.
const FIELDS = {
  characterClass: 'text',
  gender: 'text',
  llm: 'text',
  openaiBaseUrl: 'text',
  maxTokens: 'int',
  maxMessages: 'int',
  temperature: 'float',
  reasoningEffort: 'text',
  watchPort: 'int',
  rustLog: 'text',
}

/// The fighter's own knobs. Unlike FIELDS they are not staged behind the
/// Settings modal's Apply: the drawer is open over the running session, so a
/// change saves at once and a live agent picks it up on Apply & restart.
const HUNT_FIELDS = {
  workerLevelMargin: 'int',
  workerLowHealthPct: 'int',
  workerBagFullPct: 'int',
  workerPatrolRadius: 'int',
  workerFoodStock: 'int',
  workerPotionStock: 'int',
  workerScrollStock: 'int',
}

/// What a town trip may restock, by category — the game's fixed item list
/// (deps/OpenMMO/data/items.json), not something a server varies. The first
/// entry of each is what an unset (`''`, "Auto") config falls back to.
const RESTOCK_ITEMS = {
  workerFoodItem: [
    'apple',
    'bread',
    'cheese',
    'jerky',
    'lembas_wafer',
    'grilled_minnow',
    'grilled_perch',
    'grilled_trout',
    'grilled_salmon',
    'grilled_sturgeon',
  ],
  workerPotionItem: ['healing_potion', 'greater_healing_potion'],
  workerScrollItem: ['scroll_of_return'],
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
  $('characterClass').innerHTML = classes
    .map((c) => `<option value="${c.id}">${t(c.id)}</option>`)
    .join('')
  $('characterClass').value = settings.characterClass
  renderGenderOptions()
}

function renderGenderOptions() {
  const cls = classes.find((c) => c.id === settings.characterClass)
  const allowed = cls ? cls.genders : ['male', 'female']
  $('gender').innerHTML = allowed.map((g) => `<option value="${g}">${t(g)}</option>`).join('')
  if (!allowed.includes(settings.gender)) settings.gender = allowed[0]
  $('gender').value = settings.gender
  $('genderHint').textContent =
    allowed.length === 1
      ? t('Only a {gender} model exists for {class}.', {
          gender: t(allowed[0]),
          class: t(settings.characterClass),
        })
      : t('Changing gender on an existing character recreates it — level and items reset.')
}

/// Where the agent's own LLM is, for the parts of the panel that need to show
/// it. backends.js is CommonJS in the main process and cannot be imported into
/// this sandbox, so the join is restated here — but only the join: the record
/// it reads, openrouter's fixed baseUrl included, is the same table main
/// resolves against, handed over at startup.
function agentEndpoint() {
  const b = backend()
  if (b.kind !== 'http') return null
  return {
    base: String(b.baseUrl || settings.openaiBaseUrl || '').replace(/\/+$/, ''),
    model: settings.models[settings.llm] || '',
    key: settings[`${b.id}Key`] || '',
  }
}

/// What the Anchor dropdown is offering, by option index — read back when one
/// is picked. The list itself is settingsPanel's decision.
let anchorOptions = [null]

/// A coordinate name is player-written, so the options are built as nodes
/// rather than markup.
function renderAnchorOptions() {
  const select = $('workerAnchor')
  const { choices, selected } = settingsPanel.anchorChoices(settings)
  anchorOptions = choices
  select.innerHTML = ''
  for (const [i, choice] of choices.entries()) {
    const option = document.createElement('option')
    option.value = String(i)
    option.textContent = choice
      ? `${choice.name || t('Custom')} (${Math.round(choice.x)}, ${Math.round(choice.z)})`
      : t('Spawn point')
    select.appendChild(option)
  }
  select.value = String(selected)
}

/// One restock picker: "Auto" (the id agent-client falls back to on an empty
/// config) plus every item that category can hold, named the way the bag
/// already names items rather than a second translation of the same word.
function renderRestockOptions() {
  for (const [id, items] of Object.entries(RESTOCK_ITEMS)) {
    const select = $(id)
    select.innerHTML =
      `<option value="">${t('Auto')}</option>` +
      items.map((item) => `<option value="${item}">${bagWorn.itemLabel(item)}</option>`).join('')
    select.value = settings[id] || ''
  }
}

/// The whole Hunt drawer, off the current settings.
function renderHunt() {
  for (const [id, type] of Object.entries(HUNT_FIELDS)) writeField(id, type, settings[id])
  renderAnchorOptions()
  renderRestockOptions()
}

function renderBackend() {
  const b = backend()
  $('model').value = settings.models[settings.llm] || ''
  $('modelList').innerHTML = (b.models || []).map((m) => `<option value="${m}"></option>`).join('')
  $('apiKey').value = agentEndpoint()?.key || ''

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
      ? t(
          'Runs the {cli} CLI on this machine, under your own login and quota. It must work in a terminal first.',
          { cli: b.id },
        )
      : b.kind === 'http'
        ? t(
            'The key is stored encrypted by the OS and handed to the agent as an environment variable, never written to config.toml.',
          )
        : t('No LLM: the character connects and idles.')
  renderTranslation()
}

/// Translation can borrow the Agent section above it, so what the checkbox can
/// offer depends on the backend chosen there — the CLI backends run under your
/// own login and have no endpoint to share. Only a click writes the setting: a
/// backend switch re-renders and nothing else, so comparing backends, or
/// discarding the change, never costs you the borrowed endpoint. When it is on
/// the fields show what translation will actually call, written to the page
/// only, so unticking brings the typed-in ones straight back.
function renderTranslation() {
  const shared = agentEndpoint()
  const on = Boolean(shared) && settings.translateUseLlmProvider === true
  const box = $('translateUseLlm')
  box.disabled = !shared
  box.checked = on

  const hint = $('translateShareHint')
  hint.hidden = Boolean(shared)
  if (!shared) {
    hint.textContent = t('{backend} runs on this machine, so there is no endpoint to share.', {
      backend: backend().label || t('This backend'),
    })
  }

  for (const id of TRANSLATION_FIELDS) $(id).disabled = on
  $('translateBaseUrl').value = on ? shared.base : settings.translateBaseUrl || ''
  $('translateModel').value = on ? shared.model : settings.translateModel || ''
  $('translateKey').value = on ? shared.key : settings.translateKey || ''
}

/// The lamp and the state word, from the one pair of facts that decide them:
/// whether the agent process is up, and what the play session is doing while
/// it is. Called by both `setStatus` (process) and `applyPlayState` (session)
/// so the two can no longer disagree about what to call the same state.
function renderDutyState() {
  const state = dutyState(running, sessionPhase, retryAt - Date.now())
  $('dot').className = `dot${running ? ' on' : ''}`
  $('status').textContent = state.label
  $('status').dataset.tone = state.tone
}

/// Once running is false, whatever screen is showing bounces back to
/// wherever restarting makes sense — Character, for a session that was
/// already playing.
function setStatus(state) {
  running = state.running
  renderDutyState()
  $('agentPid').textContent = running ? t('Agent · pid {pid}', { pid: state.pid }) : ''
  $('restart').hidden = !(running && dirtyWhileRunning)
  $('pauseAgent').querySelector('.i-pause').toggleAttribute('hidden', !running)
  $('pauseAgent').querySelector('.i-play').toggleAttribute('hidden', running)
  $('pauseAgent').title = running ? t('Pause the agent') : t('Resume the agent')
  $('pauseAgent').setAttribute('aria-label', $('pauseAgent').title)
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
  // The staged-changes note says whether Apply will also restart the agent,
  // so it has to follow the agent starting or stopping under an open modal.
  updateSettingsFooter()
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

function setCharacterTab(name) {
  for (const btn of document.querySelectorAll('#characterTabs .tab')) {
    btn.classList.toggle('on', btn.dataset.characterTab === name)
  }
  for (const panel of document.querySelectorAll('[data-character-panel]')) {
    panel.hidden = panel.dataset.characterPanel !== name
  }
}

function bindCharacterTabs() {
  for (const btn of document.querySelectorAll('#characterTabs .tab')) {
    btn.addEventListener('click', () => setCharacterTab(btn.dataset.characterTab))
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
  // Unmarked from here on: a later language switch would otherwise re-apply
  // the markup's default hint over the problem it is reporting.
  $('viewHint').removeAttribute('data-i18n')
  $('viewHint').textContent = message
  const frame = $('frame')
  frame.hidden = true
  frame.removeAttribute('src')
  delete frame.dataset.url
  $('placeholder').hidden = false
  settingsPanel.updateAudioAvailability()
}

/// Cached off the last vitals push — the agent-client's /api/state carries
/// the character's own position in `self.position`.
let lastSelf = null

/// The rolled attributes, and the relay's separate reading of the two that
/// gear moves. They arrive on different pushes, so the strip is drawn from
/// whichever came last plus whatever is already here.
let lastAttributes = null
let effectiveStats = null

/// The header's duty card: who is on the desk, not how they are doing. The
/// HP/XP/food meters that used to sit here are the game view's own top-left
/// HUD now, fed by the same mirror.
function setVitals(v) {
  if (!v || !v.self) {
    lastSelf = null
    $('dutyLevel').hidden = true
    $('dutyName').textContent = settings?.characterName || '—'
    actionToasts.clear()
    bagWorn.renderBag([], null, null)
    bagWorn.renderWorn({})
    bagWorn.renderSkills({})
    renderAttributes(null)
    return
  }
  const s = v.self
  lastSelf = s
  $('dutyName').textContent = s.name
  $('dutyLevel').textContent = `LV ${s.level}`
  $('dutyLevel').hidden = false
  actionToasts.push(settings, v.actions, monsterNames)
  bagWorn.renderBag(v.bag, v.weight, v.gold)
  renderAttributes(v.attributes)
}

/// What the character plays with: the rolled attributes, with guard and CHA at
/// the values the server reads once the gear is on. The value is the whole
/// number — the brass `+N` beside it says how much of it a worn ring or
/// breastplate is providing.
function renderAttributes(attributes) {
  lastAttributes = attributes
  const cells = attributeCells(attributes, effectiveStats)
  const list = $('statGrid')
  list.innerHTML = ''
  for (const cell of cells) {
    const row = document.createElement('div')
    row.className = 'attr-row'
    const label = document.createElement('span')
    label.className = 'attr-key'
    label.textContent = cell.label
    const value = document.createElement('span')
    value.className = 'attr-value'
    value.textContent = cell.value
    row.append(label, value)
    const bonus = document.createElement('span')
    bonus.className = 'attr-bonus'
    bonus.textContent = cell.bonus > 0 ? t('+{n} from gear', { n: cell.bonus }) : ''
    row.appendChild(bonus)
    list.appendChild(row)
  }
  $('statsEmpty').hidden = cells.length > 0
}

/// Player-facing title names (doc/TITLES.md, data/titles.json). Anything the
/// server awards that isn't listed falls back to itemLabel's words reading,
/// the same safety net trained skills use.
const TITLE_NAMES = {
  goblin_slayer: 'Slayer of the Goblin Chief',
  goblin_slayer_solo: 'Who Slew the Goblin Chief Alone',
  orc_slayer: 'Slayer of the Orc Warlord',
  orc_slayer_solo: 'Who Slew the Orc Warlord Alone',
  ogre_slayer: 'Slayer of the Ogre Warlord',
  ogre_slayer_solo: 'Who Slew the Ogre Warlord Alone',
}

/// One option in the title picker: the radio itself is the whole row, and the
/// group name keeps the earned list mutually exclusive with the none row.
function titleRow(id, label, checked, onChange) {
  const row = document.createElement('label')
  row.className = 'title-row'
  const input = document.createElement('input')
  input.type = 'radio'
  input.name = 'active-title'
  input.checked = checked
  input.addEventListener('change', onChange)
  const text = document.createElement('span')
  text.textContent = label
  if (!id) text.className = 'title-none'
  row.append(input, text)
  return row
}

/// Earned titles and the one shown, from the relay's view of the server's
/// PlayerTitles frames (src/proxy.js) — the agent's own panel API never
/// republishes them. Picking one sends SetActiveTitle back through the same
/// relay, and the server's answering PlayerTitles re-renders this.
function renderTitles(data) {
  const box = $('titleList')
  box.innerHTML = ''
  const earned = data && Array.isArray(data.titles) ? data.titles : []
  const active = data && data.active ? data.active : null
  $('titlesEmpty').hidden = earned.length > 0
  box.hidden = earned.length === 0
  if (earned.length === 0) return
  box.appendChild(titleRow(null, t('None'), active === null, () => setActiveTitle(null)))
  for (const id of earned) {
    const name = TITLE_NAMES[id] ? t(TITLE_NAMES[id]) : bagWorn.itemLabel(id)
    box.appendChild(titleRow(id, name, active === id, () => setActiveTitle(id)))
  }
}

async function setActiveTitle(title) {
  $('titlesStatus').hidden = true
  const res = await api.setActiveTitle(title)
  if (!res || !res.ok) {
    $('titlesStatus').textContent = t("The title can't reach the server right now.")
    $('titlesStatus').hidden = false
  }
}

/// One entry per LLM turn or game event. Prompts are long, so they start
/// clipped and open on click — except the agent's own replies, which are the
/// reason the panel exists and are short enough to read in full. Click still
/// collapses them.
function appendFeed(items) {
  const box = $('feed')
  const drawer = $('drawer')
  const watching = !drawer.hidden && drawer.dataset.kind === 'activity'
  for (const item of items) {
    if (item.k === 'llm-prompt') learnMonsterNames(item.m)
    if (item.k === 'llm-error' && !watching) markActivityUnread(true)

    const el = document.createElement('div')
    el.className = `feed-item k-${item.k}`
    if (item.k === 'llm-response') el.classList.add('open')
    el.dataset.kind = item.k
    el.hidden = feedHidden.has(item.k)

    const head = document.createElement('div')
    head.className = 'feed-head'
    const timing = item.d == null ? '' : ` · ${(item.d / 1000).toFixed(1)}s`
    const label = FEED_LABELS[item.k] ? t(FEED_LABELS[item.k]) : item.k
    head.textContent = `${new Date(item.t).toLocaleTimeString()} ${label}${timing}`

    const body = document.createElement('div')
    body.className = 'feed-body'
    body.textContent = item.m

    el.appendChild(head)
    el.appendChild(body)
    el.addEventListener('click', () => el.classList.toggle('open'))
    box.appendChild(el)
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
    b.textContent = FEED_LABELS[kind] ? t(FEED_LABELS[kind]) : kind
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

/// Display/Audio/About save on every change; LLM/Agent stage behind Apply.
/// The footer says which of the two you are looking at, so Apply is never
/// offered for a tab where there is nothing staged to apply — but it comes
/// back the moment something *is* staged, so switching tabs can never hide
/// the button for work waiting on it.
const IMMEDIATE_TABS = new Set(['display', 'audio', 'about'])

/// Provider only. Which language, and whether translation runs at all, belongs
/// to the spectator client's own chat dropdown.
const TRANSLATION_FIELDS = ['translateBaseUrl', 'translateModel', 'translateKey']
let settingsTab = 'llm'

function updateSettingsFooter() {
  const immediate = IMMEDIATE_TABS.has(settingsTab) && !settingsDirty
  $('settingsApply').hidden = immediate
  $('settingsAuto').hidden = !immediate
  $('settingsDirty').hidden = !settingsDirty
  // Applying restarts a live agent (see the settingsApply handler) — that is
  // a session interruption, and it should be on the button, not a surprise.
  $('settingsDirty').textContent = running
    ? t('Applying saves these changes and restarts the agent.')
    : t('Changes are staged until you apply them.')
}

function markSettingsDirty() {
  settingsDirty = true
  updateSettingsFooter()
}

function openSettings() {
  settingsOpener = document.activeElement
  settingsSnapshot = structuredClone(settings)
  $('settingsModal').hidden = false
  settingsDirty = false
  settingsPanel.syncAll(settings)
  $('telemetryEnabled').checked = settings.telemetry !== false
  updateSettingsFooter()
  $('settingsTabs').querySelector('.tab.on').focus()
}

async function closeSettings() {
  if (settingsDirty && !(await confirmAction(t('Discard unapplied settings changes?'), 'Discard'))) {
    return
  }
  if (settingsDirty && settingsSnapshot) {
    settings = settingsSnapshot
    for (const [id, type] of Object.entries(FIELDS)) writeField(id, type, settings[id])
    renderClassOptions()
    renderBackend()
  }
  settingsSnapshot = null
  settingsDirty = false
  $('settingsModal').hidden = true
  if (settingsOpener) settingsOpener.focus()
  settingsOpener = null
}

function setSettingsTab(name) {
  settingsTab = name
  for (const button of document.querySelectorAll('[data-settings-tab]')) {
    const on = button.dataset.settingsTab === name
    button.classList.toggle('on', on)
    button.setAttribute('aria-selected', String(on))
  }
  for (const panel of document.querySelectorAll('[data-settings-panel]')) {
    panel.hidden = panel.dataset.settingsPanel !== name
  }
  updateSettingsFooter()
}

function applyPlayState(state) {
  if (!state) return
  playMode = state.mode || playMode
  document.body.dataset.mode = playMode
  for (const [button, mode] of [
    [$('modeAi'), 'ai'],
    [$('modeManual'), 'manual'],
  ]) {
    button.classList.toggle('on', playMode === mode)
    button.setAttribute('aria-pressed', String(playMode === mode))
    button.disabled = state.phase === 'switching'
  }
  $('pauseAgent').disabled = state.phase === 'switching'
  sessionPhase = state.phase || sessionPhase
  retryAt = state.retryInMs ? Date.now() + state.retryInMs : 0
  clearInterval(retryCountdownTimer)
  retryCountdownTimer = null
  renderDutyState()
  // The countdown is the only thing on the header that moves on its own, so it
  // owns the only interval: everything else redraws on an event.
  if (retryAt) retryCountdownTimer = setInterval(renderDutyState, 250)
  if (state.notice) showErrors([state.notice])
  if (state.viewUrl) {
    sceneUrl = state.viewUrl
    applyView()
  }
}

const DRAWER_TITLES = {
  worn: 'Character',
  hunt: 'Monster Fighter',
  activity: 'Activity',
}

function railButtons() {
  return document.querySelectorAll('.rail [data-drawer]')
}

/// Both ways out of a drawer — the rail button that opened it, the × in its
/// head, Escape — end here, so the rail's lit state can only ever be cleaned
/// up one way.
function closeDrawer() {
  const drawer = $('drawer')
  drawer.hidden = true
  drawer.dataset.kind = ''
  for (const btn of railButtons()) {
    btn.classList.remove('on')
    btn.setAttribute('aria-expanded', 'false')
  }
}

function openDrawer(kind) {
  const drawer = $('drawer')
  drawer.hidden = false
  drawer.dataset.kind = kind
  for (const btn of railButtons()) {
    const on = btn.dataset.drawer === kind
    btn.classList.toggle('on', on)
    btn.setAttribute('aria-expanded', String(on))
  }
  $('drawerTitle').textContent = t(DRAWER_TITLES[kind])
  for (const panel of document.querySelectorAll('[data-drawer-panel]')) {
    panel.hidden = panel.dataset.drawerPanel !== kind
  }
  // Always land on the first tab, wherever the panel was left.
  if (kind === 'activity') setActivityTab('thoughts')
  // Settings can revert a staged change under the drawer, so the knobs are
  // written from the settings in force each time it opens.
  if (kind === 'hunt') renderHunt()
  if (kind === 'worn') setCharacterTab('stats')
  // Reading the panel is what clears the mark that said to read it.
  if (kind === 'activity') markActivityUnread(false)
}

/// Rail icons open a slide-over drawer; clicking the open one again closes it.
function bindRail() {
  for (const btn of railButtons()) {
    btn.addEventListener('click', () => {
      const drawer = $('drawer')
      if (!drawer.hidden && drawer.dataset.kind === btn.dataset.drawer) closeDrawer()
      else openDrawer(btn.dataset.drawer)
    })
  }
  $('drawerClose').addEventListener('click', closeDrawer)
  // Escape closes the drawer, the way it closes Settings — unless one of the
  // two dialogs is up, in which case Escape is theirs to answer first.
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    if (!$('settingsModal').hidden || !$('confirmModal').hidden) return
    // The session menu answers Escape itself (that is the popover's own light
    // dismiss); one press must not also shut the drawer behind it.
    if ($('sessionMenu').matches(':popover-open')) return
    if (!$('drawer').hidden) closeDrawer()
  })
}

/// An ember dot on the Activity pull when the agent hits an LLM error you
/// weren't looking at. Errors only: a mark for every turn would be lit
/// permanently, which is the same as not having one.
function markActivityUnread(on) {
  const btn = document.querySelector('.rail [data-drawer="activity"]')
  if (btn) btn.classList.toggle('alert', on)
}

function bindFields() {
  for (const [id, type] of Object.entries(FIELDS)) {
    const el = $(id)
    if (!el) continue
    el.addEventListener('change', () => {
      // Unfinished edit: keep the live value rather than let the floor win.
      if (el.type === 'number' && !isAnswered(el.value, el.min)) {
        writeField(id, type, settings[id])
        return
      }
      const value = readField(id, type)
      settings[id] = value
      // Show the clamped value, not what was typed.
      if (el.type === 'number') writeField(id, type, value)
      markSettingsDirty()
      if (id === 'characterClass') {
        renderGenderOptions()
      }
      if (id === 'llm') renderBackend()
    })
  }

  $('model').addEventListener('change', () => {
    settings.models[settings.llm] = $('model').value
    markSettingsDirty()
  })
  $('apiKey').addEventListener('change', () => {
    const key = settings.llm === 'openrouter' ? 'openrouterKey' : 'openaiKey'
    settings[key] = $('apiKey').value
    markSettingsDirty()
  })

  for (const button of document.querySelectorAll('[data-settings-tab]')) {
    button.addEventListener('click', () => setSettingsTab(button.dataset.settingsTab))
  }
}

/// Every knob in the Hunt drawer. `persist` is the same path the Character
/// screen uses: the value is written now, and a running agent is marked for
/// the drawer's own Apply & restart rather than restarted under the player.
function bindHuntFields() {
  for (const [id, type] of Object.entries(HUNT_FIELDS)) {
    $(id).addEventListener('change', () => {
      const el = $(id)
      // Unfinished edit: keep the live value rather than let the floor win.
      if (!isAnswered(el.value, el.min)) {
        writeField(id, type, settings[id])
        return
      }
      const value = readField(id, type)
      writeField(id, type, value)
      void persist({ [id]: value })
    })
  }

  $('workerAnchor').addEventListener('change', () => {
    const choice = anchorOptions[Number($('workerAnchor').value)] || null
    void persist({
      workerAnchorName: choice ? choice.name || '' : '',
      workerAnchorX: choice ? choice.x : null,
      workerAnchorZ: choice ? choice.z : null,
    })
  })

  for (const id of Object.keys(RESTOCK_ITEMS)) {
    $(id).addEventListener('change', () => void persist({ [id]: $(id).value }))
  }
}

function bindActions() {
  $('bagLabelsSubmit').addEventListener('click', () =>
    void bagWorn.submitBagLabels(signInFlow.getSelectedCharacterId(), settings.characterName),
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

  // Pause stops agent-client outright (not a mode switch) so bag labels can be
  // edited without it racing a save. Resuming reuses the same start path as
  // Apply & restart.
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
  // A copy button with no reply leaves you re-clicking it to be sure — and this
  // code is being carried to another window, so "did that work" matters.
  $('banner-copy').addEventListener('click', async () => {
    await navigator.clipboard.writeText($('banner-code').textContent)
    $('banner-copy').textContent = t('Copied')
    setTimeout(() => ($('banner-copy').textContent = t('Copy')), 1500)
  })

  $('clearLog').addEventListener('click', () => ($('log').textContent = ''))
  $('clearFeed').addEventListener('click', () => ($('feed').textContent = ''))

  // A 3D client left running all night grows; dropping the frame frees it
  // without disturbing the agent, which lives in another process entirely.
  const reloadViewFrame = () => {
    const frame = $('frame')
    const url = frame.dataset.url
    if (!url) return
    frame.removeAttribute('src')
    delete frame.dataset.url
    requestAnimationFrame(() => applyView())
  }
  $('reloadView').addEventListener('click', reloadViewFrame)
  // The spectator proxies the game's texture/model assets into a local cache
  // (server.js). Clearing it forces the next load to fetch fresh ones — the
  // point is usually a newer build of the game's assets, so reload after.
  $('clearCache').addEventListener('click', async () => {
    const res = await api.clearAssetCache()
    if (!res?.ok) {
      showErrors([res?.error || t('Could not clear the asset cache.')])
      return
    }
    reloadViewFrame()
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
    if (!(await confirmAction(t('Leave this session and choose another character?'), 'Leave'))) {
      return
    }
    await api.leavePlay('character')
    setScreen('character')
  })
  $('changeServer').addEventListener('click', async () => {
    if (!(await confirmAction(t('Leave this session and choose another server?'), 'Leave'))) return
    await api.leavePlay('server')
    await signInFlow.start()
  })
  $('settingsApply').addEventListener('click', async () => {
    showErrors([])
    $('settingsApply').disabled = true
    $('settingsApply').textContent = t('Validating…')
    const applied = await api.applySettings(settings)
    $('settingsApply').disabled = false
    $('settingsApply').textContent = t('Apply')
    if (!applied.ok) {
      showErrors(applied.errors)
      return
    }
    settings = applied.settings
    settingsDirty = false
    updateSettingsFooter()
    if (playMode === 'ai' && running) {
      const result = await api.restart()
      if (!result.ok) {
        showErrors(result.errors)
        return
      }
    }
    void closeSettings()
  })

  $('openSettingsFromGame').addEventListener('click', openSettings)
  $('settingsClose').addEventListener('click', () => void closeSettings())

  // Escape and a click on the dimmed backdrop, the two things every other
  // dialog on this machine does. Both route through closeSettings, so staged
  // changes still get their confirm. Guarded on the confirm dialog being
  // closed: it stacks above Settings, and its own Escape must not reach past
  // it to the window it is asking about.
  $('settingsModal').addEventListener('mousedown', (event) => {
    if (event.target === $('settingsModal')) void closeSettings()
  })
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    if ($('settingsModal').hidden || !$('confirmModal').hidden) return
    void closeSettings()
  })

  // The session menu's external links: community + support. They close the
  // menu and hand off to the system browser, same as the About tab used to.
  const externalLinks = [
    ['githubLink', GITHUB_URL],
    ['wikiLink', WIKI_URL],
    ['discordLink', DISCORD_URL],
    ['supportLink', SUPPORT_URL],
  ]
  for (const [id, url] of externalLinks) {
    $(id).addEventListener('click', () => api.open(url))
  }

  // Saves immediately, like toast/audio: there is nothing for Apply &
  // validate to check, and a privacy choice should never sit staged behind
  // an unrelated LLM validation round-trip. Main gates every event on the
  // stored value at send time, so this takes effect on the very next event.
  $('language').addEventListener('change', () => void switchLanguage($('language').value))

  $('telemetryEnabled').addEventListener('change', () => {
    const patch = { telemetry: $('telemetryEnabled').checked }
    settings = { ...settings, ...patch }
    if (settingsSnapshot) settingsSnapshot.telemetry = patch.telemetry
    void persistImmediateSetting(patch)
  })

  for (const id of TRANSLATION_FIELDS) {
    $(id).addEventListener('change', () => {
      const patch = { [id]: $(id).value.trim() }
      settings = { ...settings, ...patch }
      if (settingsSnapshot) settingsSnapshot[id] = patch[id]
      void persistImmediateSetting(patch)
    })
  }

  $('translateUseLlm').addEventListener('change', () => {
    const patch = { translateUseLlmProvider: $('translateUseLlm').checked }
    settings = { ...settings, ...patch }
    if (settingsSnapshot) settingsSnapshot.translateUseLlmProvider = patch.translateUseLlmProvider
    renderTranslation()
    void persistImmediateSetting(patch)
  })

  $('translateTest').addEventListener('click', async () => {
    const result = $('translateTestResult')
    $('translateTest').disabled = true
    result.hidden = false
    result.textContent = t('Translating…')
    const patch = Object.fromEntries(TRANSLATION_FIELDS.map((id) => [id, $(id).value.trim()]))
    const outcome = await api.testTranslate(patch)
    $('translateTest').disabled = false
    result.textContent = outcome.ok
      ? `${outcome.sample} → ${outcome.text}`
      : `✗ ${outcome.error}`
  })
}

window.addEventListener('message', (event) => {
  if (event.source !== $('frame').contentWindow) return
  if (event.data?.type === 'openmmo-manual-ready') void api.manualReady()
  if (event.data?.type === 'openmmo-manual-error') {
    void api.manualReady(event.data.error || t('Manual client could not enter the world'))
  }
  // The spectator client is a different origin with no preload of its own, so
  // the endpoint call (and the API key it carries) stays on this side.
  if (event.data?.type === 'openmmo-translate') {
    const { id, text, target } = event.data
    void api.translateChat(text, target).then((translated) => {
      $('frame').contentWindow?.postMessage(
        { type: 'openmmo-translate-result', id, text: translated },
        '*',
      )
    })
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

/// The dictionary is a file the main process owns, so a switch costs one
/// round-trip and then a re-scan of every marked node.
async function applyLanguage(language) {
  setDictionary(await api.dictionary(language), language)
  document.documentElement.lang = language
  applyI18n(document)
}

/// ponytail: the switch redraws the markup and the panels it was made from, not
/// every rendered list — a feed line or an action caption keeps the language it
/// was written in until its next update. Re-render the rest if that ever shows.
/// The update line in Settings is one that showed: it is written from JS, and
/// the panel it sits in is exactly where the switch is made.
async function switchLanguage(language) {
  const patch = { language }
  settings = { ...settings, ...patch }
  if (settingsSnapshot) settingsSnapshot.language = language
  await applyLanguage(language)
  await persistImmediateSetting(patch)
  renderClassOptions()
  renderBackend()
  renderHunt()
  settingsPanel.syncAll(settings)
  signInFlow.rerender()
  renderDutyState()
  renderUpdateStatus(updateState)
  updateSettingsFooter()
}

/// The updater's latest state, kept here (not in updateStatus) so the
/// outdated dialog can drive an install from any screen. `outdatedHandling`
/// is true while the dialog's own update is in flight; `outdatedInstalling`
/// stops the click handler and the updater-state watcher from both calling
/// quitAndInstall for the same ready download.
let updateState = null
let renderUpdateStatus = () => {}
let outdatedHandling = false
let outdatedInstalling = false

/// One line and one rule, always set together: the rule is the dialog's only
/// measure of how far the update has got, and a stale bar under a fresh
/// sentence is worse than no bar. `progress` is a percentage, 'full',
/// 'indeterminate', or null to draw no rule at all.
function setOutdatedStatus(text, progress = null, tone = 'working') {
  $('outdatedStatus').textContent = text
  $('outdatedStatus').hidden = !text
  const rule = $('outdatedProgress')
  rule.hidden = progress == null
  rule.dataset.tone = tone
  if (progress != null) updateStatus.paintRule($('outdatedFill'), progress)
}

/// A protocol mismatch: the server refused the build outright, so the only
/// fix is a newer one. The dialog appears above whatever screen is showing —
/// the server list, character select, or the running game — because the
/// refusal can happen on any of them.
function showOutdated(info) {
  const server = info && info.server
  const build = info && info.build
  $('outdatedMessage').textContent =
    server != null && build != null
      ? t('The server speaks protocol v{server}, but this build speaks v{build}.', { server, build })
      : t('This app is outdated. Update to the newest release to keep playing.')
  setOutdatedStatus('')
  outdatedHandling = false
  outdatedInstalling = false
  $('outdatedUpdate').disabled = false
  $('outdatedDownload').hidden = true
  $('outdatedModal').hidden = false
  $('outdatedUpdate').focus()
}

async function outdatedInstall() {
  if (outdatedInstalling) return
  outdatedInstalling = true
  setOutdatedStatus(t('Stopping the agent, then restarting.'), 'indeterminate')
  const res = await api.installUpdate()
  if (!res?.ok) {
    outdatedHandling = false
    outdatedInstalling = false
    $('outdatedUpdate').disabled = false
    // An install that cannot proceed (e.g. macOS app outside /Applications)
    // should hand off to the manual download rather than dead-end the dialog.
    $('outdatedDownload').hidden = false
    setOutdatedStatus(res?.error || t('The update could not be installed.'), 'full', 'failed')
  }
}

/// The Update button: install right away when the feed already downloaded a
/// build, otherwise kick the check and let the updater-state watcher install
/// the moment the download lands.
async function startOutdatedUpdate() {
  if (outdatedHandling) return
  outdatedHandling = true
  $('outdatedUpdate').disabled = true
  $('outdatedDownload').hidden = true
  setOutdatedStatus(t('Checking for updates…'), 'indeterminate')
  if (updateState?.status === 'ready') {
    await outdatedInstall()
    return
  }
  await api.checkUpdate()
  if (updateState?.status === 'ready') await outdatedInstall()
}

/// While the outdated dialog's update is in flight, watch the updater to the
/// end: a ready download installs itself, a downloading/checking one keeps the
/// status honest, and anything else means the feed had no newer build — offer
/// the manual download page instead of leaving the button spinning.
function outdatedUpdateState(state) {
  updateState = state
  if (!outdatedHandling) return
  switch (state?.status) {
    case 'ready':
      // A refused install parks the build back at ready with its reason;
      // reinstalling on the spot would just fail the same way.
      if (state.message) {
        outdatedHandling = false
        outdatedInstalling = false
        $('outdatedUpdate').disabled = false
        $('outdatedDownload').hidden = false
        setOutdatedStatus(state.message, 'full', 'failed')
      } else void outdatedInstall()
      break
    case 'downloading':
      setOutdatedStatus(
        state.percent == null
          ? t('Downloading v{version}…', { version: state.version ?? '…' })
          : t('Downloading v{version} — {percent}%', { version: state.version ?? '…', percent: state.percent }),
        state.percent ?? 'indeterminate',
      )
      break
    case 'installing':
    case 'checking':
      break
    default:
      outdatedHandling = false
      $('outdatedUpdate').disabled = false
      $('outdatedDownload').hidden = false
      setOutdatedStatus(t('The updater found no newer build here. Download it manually.'), 'full', 'failed')
      break
  }
}

function bindOutdatedDialog() {
  $('outdatedUpdate').addEventListener('click', () => void startOutdatedUpdate())
  $('outdatedDismiss').addEventListener('click', () => {
    $('outdatedModal').hidden = true
  })
  $('outdatedDownload').addEventListener('click', () => void api.openDownloadPage())
  api.onOutdated(showOutdated)
  api.onUpdateState(outdatedUpdateState)
}

async function init() {
  const info = await api.info()
  settings = info.settings
  backends = info.backends
  classes = info.classes

  await applyLanguage(settings.language)
  writeField('language', 'text', settings.language)

  $('llm').innerHTML = backends
    .filter((backend) => backend.kind !== 'none')
    .map((backend) => `<option value="${backend.id}">${backend.label}</option>`)
    .join('')
  for (const [id, type] of Object.entries(FIELDS)) writeField(id, type, settings[id])
  renderClassOptions()
  renderBackend()
  renderHunt()
  actionToasts.applyToastCssVars(settings)

  for (const item of info.log) appendLog(item)

  setStatus(info.status)
  // A window reopened onto a session that never stopped gets no `view:ready`
  // of its own — that fires once, when the agent's watch server comes up — so
  // ask for the scene rather than sitting on the "nothing to watch" card.
  if (info.status.running) void api.openView()

  bindFields()
  bindHuntFields()
  bindActions()
  bindRail()
  bindActivityTabs()
  bindCharacterTabs()
  signInFlow.init({
    getSettings: () => settings,
    persist,
    applyPlayState,
    openSettings,
  })
  settingsPanel.bind({
    getSettings: () => settings,
    onImmediateChange: (patch) => {
      settings = { ...settings, ...patch }
      void persistImmediateSetting(patch)
    },
  })

  $('appVersion').textContent = info.appVersion
  renderUpdateStatus = updateStatus.mount(api)
  updateState = info.update
  renderUpdateStatus(updateState)

  renderFeedFilters()
  bagWorn.renderWorn({})
  bagWorn.renderSkills({})
  renderTitles(null)
  api.onLog(appendLog)
  api.onFeed(appendFeed)
  api.onVitals(setVitals)
  api.onWorn(bagWorn.renderWorn)
  api.onSkills(bagWorn.renderSkills)
  api.onTitles(renderTitles)
  api.onStats((stats) => {
    effectiveStats = stats
    renderAttributes(lastAttributes)
  })
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
    $('mem').textContent = mb ? t('Using {mb} MB', { mb }) : ''
    $('mem').classList.toggle('high', mb > 1500)
  })
  api.onViewError(showViewProblem)
  api.onState(setStatus)
  api.onDeviceCode(signInFlow.showDeviceCode)
  // Protocol mismatches are the outdated dialog's job, not a dismissible
  // toast — the message they carry is the dev-facing "run check-protocol.js".
  api.onFatal((message) => {
    if (typeof message === 'string' && message.startsWith('The server speaks protocol')) return
    showErrors([message])
  })
  bindOutdatedDialog()
  api.onPlayState(applyPlayState)
  // The watch server coming up is what says the session is live; main.js sends
  // the scene URL off the same event.
  api.onWatchReady(() => {
    if (running) setScreen('game')
  })

  await signInFlow.start()
}

init()
