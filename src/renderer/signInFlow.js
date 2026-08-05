'use strict'

import { AppWorkflow } from '../workflow.js'
import { $, showErrors, setScreen, confirmAction } from './dom.js'
import * as bagWorn from './bagWorn.js'
import * as dispatchBook from './dispatchBook.js'

const api = window.agentApp

let workflow = null
let profiles = []
let selectedProfileId = null
let editingProfileId = null

// Pre-flight session state: the character list fetched at sign-in,
// and which one is chosen for this Play. Bumped on every sign-in attempt so
// a stale device-flow poll (abandoned via "Start over") can't resolve later
// and yank the screen back.
let characters = []
let selectedCharacterId = null
let signInGeneration = 0

/// `deps` are the app.js-owned pieces this flow reads/reports through rather
/// than importing app.js directly (which would be a cycle): `getSettings`
/// for the live settings object, `persist` for the Apply-gated save path,
/// `applyPlayState` for the handoff once a character enters the game, and
/// `openSettings` for the Character screen's "connection" tab.
let deps = null

export function getSelectedCharacterId() {
  return selectedCharacterId
}

/// The Login screen's three mutually exclusive states: checking
/// the cache, a cached credential to continue with, or a fresh device code.
function showLoginState(state) {
  $('loginChecking').hidden = state !== 'checking'
  $('loginCode').hidden = state !== 'code'
}

export function showDeviceCode(code) {
  if (!code || !code.code) return
  $('banner-code').textContent = code.code
  $('loginCode').dataset.url = code.url || 'https://www.google.com/device'
  showLoginState('code')
}

/// Runs the device flow (main process does the actual OAuth).
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
/// mismatch or a refused sign-in alike. Login is the first screen
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
    await deps.persist({ characterName: '' })
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
    deps.applyPlayState(state.session)
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
        deps.openSettings()
        return
      }
      setCharacterTab(btn.dataset.tab)
    })
  }
}

/// One row per existing character (max 3, server-enforced): pick it, or
/// delete it. Pre-flight session fully owns this CRUD — nothing
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
  await deps.persist({ characterName: character.name })
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
  deps.persist({ characterName: chosen ? chosen.name : '' })
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
  const name = deps.getSettings().characterName
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
    await deps.persist({ characterName: '' })
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

function bind() {
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
    const settings = deps.getSettings()
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
  bindCharacterTabs()
  bind()
}

export function start() {
  return workflow.start()
}
