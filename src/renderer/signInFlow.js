'use strict'

import { AppWorkflow } from '../workflow.js'
import { $, showErrors, setScreen, confirmAction } from './dom.js'
import { t, language } from './i18n.js'
import * as bagWorn from './bagWorn.js'

const api = window.agentApp

let workflow = null
let profiles = []
let selectedProfileId = null
let editingProfileId = null

/// True from Continue until the server has either answered or failed. The
/// workflow has always published this; nothing used to render it, so an
/// unreachable server looked identical to an idle screen for the whole timeout.
let connecting = false

/// The profile editor is a form over the same card as Continue. While it is
/// open, Continue would connect with the old profile and drop whatever was
/// typed without saying so, so the list and its actions go inert instead.
let editorOpen = false

// Pre-flight session state: the character list fetched at sign-in,
// and which one is chosen for this Play.
let characters = []
let selectedCharacterId = null

/// The character currently being taken into the world, if any. Entering runs
/// several round-trips (personality, coords, presets, bag labels, then the
/// join itself), so the slot says so and the rest of the roll goes inert
/// rather than letting a second slot be clicked mid-flight.
let enteringId = null

/// Set the moment a character enters the world, because the profile list this
/// renderer holds is not refetched on the way back from a session — without it
/// the "last played" mark would still point at the previous character.
let lastPlayedId = null

/// `deps` are the app.js-owned pieces this flow reads/reports through rather
/// than importing app.js directly (which would be a cycle): `getSettings`
/// for the live settings object, `persist` for the Apply-gated save path,
/// `applyPlayState` for the handoff once a character enters the game, and
/// `openSettings` for the settings modal.
let deps = null

const MAX_CHARACTERS = 3
const SLOT_NUMERALS = ['I', 'II', 'III']

export function getSelectedCharacterId() {
  return selectedCharacterId
}

/// The Login screen's three mutually exclusive states: checking the cache, a
/// fresh device code, or a sign-in that came back refused. 'failed' exists
/// because a refused sign-in used to leave the screen pulsing "checking…"
/// forever with nothing but Back to servers to click.
function showLoginState(state) {
  $('loginChecking').hidden = state !== 'checking'
  $('loginCode').hidden = state !== 'code'
  $('loginFailed').hidden = state !== 'failed'
}

export function showDeviceCode(code) {
  if (!code || !code.code) return
  const url = code.url || 'https://www.google.com/device'
  $('banner-code').textContent = code.code
  $('loginCode').dataset.url = url
  // Label the button with the page it actually opens, rather than the one
  // hardcoded in the markup — a custom profile can point somewhere else.
  $('banner-open').textContent = t('Open {page}', { page: url.replace(/^https?:\/\//, '') })
  showLoginState('code')
}

function profileById(id) {
  return profiles.find((profile) => profile.id === id)
}

/// How long ago, in the coarsest unit that still says something. A full locale
/// timestamp answered a question nobody asks about a connection check ("at
/// 12:01:41 AM") instead of the one they do ("is this still current?").
export function agoLabel(checkedAt, now = Date.now()) {
  const seconds = Math.round((checkedAt - now) / 1000)
  const units = [
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ]
  const relative = new Intl.RelativeTimeFormat(language(), { numeric: 'auto' })
  for (const [unit, span] of units) {
    if (Math.abs(seconds) >= span) return relative.format(Math.round(seconds / span), unit)
  }
  return t('just now')
}

/// One reading of a profile's verification state, used by both the row's dot
/// and the status line under the list — they used to format it separately and
/// disagree, and the row's copy truncated a real error mid-sentence.
export function profileStatus(profile) {
  const validation = profile?.validation
  if (validation?.ok) {
    return {
      tone: 'ok',
      label: t('Verified'),
      detail: t('Verified {ago}', { ago: agoLabel(validation.checkedAt) }),
    }
  }
  if (validation?.error) {
    return { tone: 'bad', label: t('Unreachable'), detail: validation.error }
  }
  return {
    tone: 'unknown',
    label: t('Not verified'),
    detail: t('Not verified yet — Continue checks the server before signing in.'),
  }
}

/// `focusSelected` is only true when the keyboard moved the selection, so a
/// routine re-render never yanks focus out from under a click.
function renderProfiles(focusSelected = false) {
  const box = $('profileList')
  const inert = connecting || editorOpen
  box.innerHTML = ''
  for (const profile of profiles) {
    const on = profile.id === selectedProfileId
    const status = profileStatus(profile)
    const row = document.createElement('button')
    row.type = 'button'
    row.className = `profile-row${on ? ' on' : ''}`
    row.setAttribute('role', 'option')
    row.setAttribute('aria-selected', String(on))
    // Roving tabindex: the list is one tab stop and the arrow keys move
    // within it, the way a listbox is expected to behave.
    row.tabIndex = on ? 0 : -1
    row.disabled = inert
    row.innerHTML =
      '<span class="status-dot"></span>' +
      '<span class="profile-text"><span class="profile-name"></span><span class="profile-meta"></span></span>' +
      '<span class="profile-flags"></span>'
    const dot = row.querySelector('.status-dot')
    dot.dataset.tone = status.tone
    dot.title = status.label
    row.querySelector('.profile-name').textContent = profile.name
    row.querySelector('.profile-meta').textContent = profile.serverUrl
    const flags = row.querySelector('.profile-flags')
    if (profile.kind === 'builtin') flags.appendChild(tag(t('Built-in')))
    if (profile.lastSession?.characterId != null) flags.appendChild(tag(t('Last played'), true))
    row.addEventListener('click', () => selectProfile(profile.id))
    // Double-click continues, matching how a character slot is entered: one
    // click to consider it, a second to commit.
    row.addEventListener('dblclick', () => workflow.continueWithProfile(profile.id))
    row.addEventListener('keydown', onProfileKey)
    box.appendChild(row)
  }
  const selected = profileById(selectedProfileId)
  $('profileEdit').disabled = inert || !selected || selected.kind === 'builtin'
  $('profileDelete').disabled = inert || !selected || selected.kind === 'builtin'
  $('profileDuplicate').disabled = inert || !selected
  $('profileNew').disabled = inert
  $('profileTest').disabled = inert || !selected
  $('profileContinue').disabled = inert || !selected
  $('profileContinue').textContent = connecting ? t('Connecting…') : t('Continue')
  $('profileContinue').classList.toggle('working', connecting)
  if (focusSelected) box.querySelector('.profile-row.on')?.focus()
}

function tag(text, brass = false) {
  const span = document.createElement('span')
  span.className = `tag${brass ? ' brass' : ''}`
  span.textContent = text
  return span
}

function selectProfile(id) {
  selectedProfileId = id
  renderProfiles()
  renderProfileStatus()
}

function onProfileKey(event) {
  if (event.key === 'Enter') {
    // A focused row is by definition the selected one, so Enter is unambiguous:
    // commit. preventDefault stops the button's own click from firing after.
    event.preventDefault()
    workflow.continueWithProfile(selectedProfileId)
    return
  }
  const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
  if (!step) return
  event.preventDefault()
  const index = profiles.findIndex((profile) => profile.id === selectedProfileId)
  const next = profiles[Math.min(Math.max(index + step, 0), profiles.length - 1)]
  if (!next || next.id === selectedProfileId) return
  selectedProfileId = next.id
  renderProfiles(true)
  renderProfileStatus()
}

function renderProfileStatus() {
  const profile = profileById(selectedProfileId)
  $('profileStatus').textContent = profile ? profileStatus(profile).detail : ''
}

function openProfileEditor(profile = null) {
  editingProfileId = profile?.id || null
  $('profileEditorTitle').textContent = profile
    ? t('Edit {name}', { name: profile.name })
    : t('New server')
  $('profileName').value = profile?.name || ''
  $('profileServer').value = profile?.serverUrl || ''
  $('profileTerrain').value = profile?.terrainOrigin || ''
  $('profileClientId').value = profile?.googleClientId || ''
  $('profileClientSecret').value = ''
  $('profileEditor').hidden = false
  editorOpen = true
  renderProfiles()
  // Also scrolls the editor into view on a short window, where it opens below
  // the fold and clicking New would otherwise look like it did nothing.
  $('profileName').focus()
}

function closeProfileEditor() {
  editingProfileId = null
  $('profileEditor').hidden = true
  editorOpen = false
  renderProfiles()
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
    connecting = Boolean(state.busy)
    setScreen('server')
    renderProfiles()
    renderProfileStatus()
  } else if (state.screen === 'oauth') {
    connecting = false
    setScreen('login')
    // Errors on this screen mean the sign-in itself came back refused; the
    // device code, if any, is spent.
    showLoginState(state.errors?.length ? 'failed' : 'checking')
  } else if (state.screen === 'character') {
    connecting = false
    characters = state.characters
    $('accountName').textContent = state.accountName || ''
    if (enteringScreen) {
      selectedCharacterId = null
      enteringId = null
    }
    renderCharacterList()
    // A brand-new account has nothing to choose between, so open the form
    // it would have to reach for anyway.
    if (enteringScreen) showCreate(characters.length === 0)
    setScreen('character')
  } else if (state.screen === 'game') {
    setScreen('game')
    deps.applyPlayState(state.session)
  }
}

function showCreate(on) {
  $('rosterPanel').hidden = on
  $('createPanel').hidden = !on
  $('backToRoster').hidden = characters.length === 0
  if (on) $('newCharacterName').focus()
}

/// One slot per character the account may hold — filled ones enter the world,
/// empty ones are the way into the create form. Pre-flight session fully owns
/// this CRUD; nothing here talks to agent-client.
function renderCharacterList() {
  const box = $('characterList')
  box.innerHTML = ''
  box.setAttribute('aria-busy', String(enteringId != null))
  for (let index = 0; index < MAX_CHARACTERS; index++) {
    const character = characters[index]
    box.appendChild(character ? filledSlot(character, index) : emptySlot(index))
  }
}

function filledSlot(character, index) {
  const entering = character.id === enteringId
  const slot = document.createElement('div')
  slot.className = `slot${entering ? ' entering' : ''}`
  slot.innerHTML =
    '<button type="button" class="slot-pick">' +
    '<span class="slot-no"></span>' +
    '<span class="slot-id"><span class="slot-name"></span><span class="slot-class"></span></span>' +
    '<span class="slot-flags"></span>' +
    '<span class="slot-level"></span>' +
    '<span class="slot-cue"></span>' +
    '</button>' +
    '<button type="button" class="slot-delete">' +
    '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" ' +
    'stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13M10 11v5M14 11v5" /></svg>' +
    '<span></span>' +
    '</button>'
  slot.querySelector('.slot-no').textContent = SLOT_NUMERALS[index]
  slot.querySelector('.slot-name').textContent = character.name
  slot.querySelector('.slot-class').textContent = `${t(character.class)} · ${t(character.gender)}`
  slot.querySelector('.slot-level').textContent = t('Lv {level}', { level: character.level })
  slot.querySelector('.slot-cue').textContent = entering ? t('Entering') : '›'
  slot.querySelector('.slot-delete span').textContent = t('Delete')
  // Its own column rather than stacked under the class: in the name block it
  // made whichever slot carried it taller than the others.
  if (isLastPlayed(character.id)) slot.querySelector('.slot-flags').appendChild(tag(t('Last played'), true))

  const pick = slot.querySelector('.slot-pick')
  const remove = slot.querySelector('.slot-delete')
  pick.disabled = enteringId != null
  remove.disabled = enteringId != null
  pick.setAttribute(
    'aria-label',
    t('Play {name}, level {level} {class}', {
      name: character.name,
      level: character.level,
      class: t(character.class),
    }),
  )
  remove.setAttribute('aria-label', t('Delete {name}', { name: character.name }))
  pick.addEventListener('click', () => void enterCharacter(character))
  remove.addEventListener('click', () => void deleteCharacterSlot(character.id, character.name))
  return slot
}

function emptySlot(index) {
  const slot = document.createElement('div')
  slot.className = 'slot slot-empty'
  slot.innerHTML =
    '<button type="button" class="slot-pick">' +
    '<span class="slot-no"></span>' +
    '<span class="slot-empty-label"></span>' +
    '<span class="slot-cue">+</span>' +
    '</button>'
  slot.querySelector('.slot-no').textContent = SLOT_NUMERALS[index]
  slot.querySelector('.slot-empty-label').textContent = t('Create a character')
  const pick = slot.querySelector('.slot-pick')
  pick.disabled = enteringId != null
  pick.addEventListener('click', () => showCreate(true))
  return slot
}

function isLastPlayed(id) {
  return (lastPlayedId ?? profileById(selectedProfileId)?.lastSession?.characterId) === id
}

async function enterCharacter(character) {
  if (enteringId != null) return
  showErrors([])
  enteringId = character.id
  selectedCharacterId = character.id
  renderCharacterList()
  try {
    await deps.persist({ characterName: character.name })
    await bagWorn.loadBagLabels(selectedCharacterId)
    lastPlayedId = character.id
    await workflow.chooseCharacter(character.id)
  } catch (err) {
    // The pre-flight bag-label load is a disk read that can fail. Without this
    // the slot just quietly came back to life, as if the click had never
    // happened.
    showErrors([t('Could not enter as {name}: {reason}', { name: character.name, reason: err.message })])
  } finally {
    // Cleared whether the join succeeded (the screen has moved on and this
    // render is harmless) or failed (the roll has to come back to life).
    enteringId = null
    renderCharacterList()
  }
}

async function deleteCharacterSlot(id, name) {
  if (!(await confirmAction(t('Delete {name}? This cannot be undone.', { name })))) return
  const res = await api.deleteCharacter(id)
  if (!res.ok) {
    showErrors([res.error])
    return
  }
  characters = characters.filter((c) => c.id !== id)
  if (lastPlayedId === id) lastPlayedId = null
  if (selectedCharacterId === id) {
    selectedCharacterId = null
    await deps.persist({ characterName: '' })
  }
  renderCharacterList()
  if (!characters.length) showCreate(true)
}

function bind() {
  $('profileContinue').addEventListener('click', () => workflow.continueWithProfile(selectedProfileId))
  $('profileTest').addEventListener('click', async () => {
    $('profileTest').disabled = true
    const result = await api.testProfile(selectedProfileId)
    $('profileTest').disabled = false
    profiles = await api.listProfiles()
    renderProfiles()
    renderProfileStatus()
    // A protocol mismatch is the outdated dialog's job, not an error toast —
    // main already sent agent:outdated for it.
    if (!result.ok && !result.protocolMismatch) showErrors([result.error])
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
    if (!(await confirmAction(t('Delete {name} and its saved Google login?', { name: profile.name })))) return
    profiles = await api.deleteProfile(profile.id)
    selectedProfileId = profiles.find((candidate) => candidate.selected)?.id || profiles[0]?.id
    renderProfiles()
    renderProfileStatus()
  })
  $('profileCancel').addEventListener('click', closeProfileEditor)
  // Escape is the expected way out of a panel you opened by mistake, and focus
  // is always inside the editor while it is open.
  $('profileEditor').addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeProfileEditor()
  })
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
  $('loginRetry').addEventListener('click', () => workflow.continueWithProfile(selectedProfileId))

  $('switchAccount').addEventListener('click', async () => {
    await api.signOut()
    await workflow.continueWithProfile(selectedProfileId)
  })

  // The only way to the LLM settings used to be the in-game rail, so a first
  // run had to join the world with an unconfigured agent to fix it.
  $('openSettingsFromCharacter').addEventListener('click', () => deps.openSettings())

  $('backToRoster').addEventListener('click', () => {
    showErrors([])
    showCreate(false)
  })

  $('createCharacter').addEventListener('click', async () => {
    showErrors([])
    const name = $('newCharacterName').value.trim()
    if (!name) {
      showErrors([t('Character name is required')])
      $('newCharacterName').focus()
      return
    }
    $('createCharacter').disabled = true
    $('createCharacter').textContent = t('Creating…')
    const settings = deps.getSettings()
    const res = await api.createCharacter(name, settings.characterClass, settings.gender)
    $('createCharacter').disabled = false
    $('createCharacter').textContent = t('Create and enter the world')
    if (!res.ok) {
      showErrors([res.error])
      return
    }
    characters.push(res.character)
    $('newCharacterName').value = ''
    showCreate(false)
    renderCharacterList()
    await enterCharacter(res.character)
  })
}

/// `dependencies`: `{ getSettings, persist, applyPlayState, openSettings }`
/// — see the `deps` comment above. Constructs the AppWorkflow instance and
/// wires every profile/login/roster control; call start() afterward once
/// app.js has finished its own init() wiring.
export function init(dependencies) {
  deps = dependencies
  workflow = new AppWorkflow(
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
  bind()
}

export function start() {
  return workflow.start()
}

/// Redraws the rows this flow owns. The entry screens are where a first run
/// picks a language, and their rows are written in JS rather than marked up,
/// so without this the list keeps its old language behind the modal.
export function rerender() {
  renderProfiles()
  renderProfileStatus()
  renderCharacterList()
}
