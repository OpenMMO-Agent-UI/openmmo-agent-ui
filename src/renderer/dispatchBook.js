'use strict'

import { $, showErrors } from './dom.js'

const api = window.agentApp

/// A directive (ADR 0003): best-effort, so its reply is tracked and shown
/// right next to what was sent rather than assumed to have landed.
let pendingDirective = null

/// Records what was sent so the reply (below) can be matched back to it.
export function trackDirective(text) {
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

/// Best-effort, not guaranteed (ADR 0003): show the agent's next turn right
/// next to the directive, so a player can see whether it landed instead of
/// trusting it silently worked. Called from the feed panel as items arrive.
export function consumeReply(item) {
  if (pendingDirective && (item.k === 'llm-response' || item.k === 'llm-error') && item.t >= pendingDirective.sentAt) {
    $('directiveReply').textContent = item.m
    pendingDirective = null
  }
}

async function sendDirective(text) {
  const res = await api.sendDirective(text)
  if (!res.ok) {
    showErrors([res.error])
    return
  }
  trackDirective(text)
}

/// The character/profile currently selected — kept in step by loadCoords and
/// loadPresets (called on every character switch), so row-level click
/// handlers built at render time never act on a stale character.
let currentCharacterId = null

const BUILTIN_COORDS = [
  { name: 'Aldermark', x: -1471.4, y: 0.9, z: 4741.2 },
  { name: 'Merchant Rica', x: -1473.8, y: 1.1, z: 4735.5 },
  { name: 'Fishing spot', x: -1501.6, y: 0.3, z: 4732.3 },
  { name: 'Old Crypt', x: -1450, y: 0.7, z: 4720 },
  { name: 'Orc Warren', x: -1616, y: 1.05, z: 4918 },
]
let customCoords = []

/// Player-saved coordinates, reloaded on every character switch — scoped the
/// same way as the personality text (per connection profile + character).
export async function loadCoords(characterId) {
  currentCharacterId = characterId
  customCoords = characterId ? await api.listCoordinates(characterId) : []
  renderCoords()
}

function coordRow(coord, removable) {
  const row = document.createElement('div')
  row.className = 'coord-row'
  const go = document.createElement('button')
  go.type = 'button'
  go.className = 'coord-go'
  go.textContent = `${coord.name} (${coord.x}, ${coord.y}, ${coord.z})`
  go.addEventListener('click', () =>
    sendDirective(`Go to ${coord.name} (${coord.x}, ${coord.y}, ${coord.z}) immediately without questioning.`),
  )
  row.appendChild(go)
  if (removable) {
    const del = document.createElement('button')
    del.type = 'button'
    del.className = 'ghost small coord-delete'
    del.textContent = '×'
    del.title = 'Remove'
    del.addEventListener('click', async () => {
      const res = await api.deleteCoordinate(currentCharacterId, coord.id)
      if (res.ok) {
        customCoords = res.list
        renderCoords()
      }
    })
    row.appendChild(del)
  }
  return row
}

export function renderCoords() {
  const box = $('coordsList')
  box.innerHTML = ''
  for (const coord of BUILTIN_COORDS) box.appendChild(coordRow(coord, false))
  for (const coord of customCoords) box.appendChild(coordRow(coord, true))
}

const BUILTIN_PRESETS = [
  { name: 'Idle', prompt: 'Stay at where you are and do nothing until ~Director~ give you instructions.' },
  { name: 'Go Fishing', prompt: 'Go to Fishing spot and cast {"type": "fish"}' },
  { name: 'Sell Items', prompt: 'Go find Merchant Rica and sell any sellable items.' },
]
let customPresets = []
let editingPresetId = null

/// Player-saved dispatch presets, reloaded on every character switch — same
/// per-character scoping as Coordinates.
export async function loadPresets(characterId) {
  currentCharacterId = characterId
  customPresets = characterId ? await api.listPresets(characterId) : []
  renderPresets()
}

function presetRow(preset, editable) {
  const row = document.createElement('div')
  row.className = 'preset-row'
  const go = document.createElement('button')
  go.type = 'button'
  go.className = 'preset-go'
  go.textContent = preset.name
  go.title = preset.prompt
  go.addEventListener('click', () => sendDirective(preset.prompt))
  row.appendChild(go)
  if (editable) {
    const edit = document.createElement('button')
    edit.type = 'button'
    edit.className = 'ghost small preset-edit'
    edit.textContent = '✎'
    edit.title = 'Edit'
    edit.addEventListener('click', () => startEditPreset(preset))
    row.appendChild(edit)

    const del = document.createElement('button')
    del.type = 'button'
    del.className = 'ghost small preset-delete'
    del.textContent = '×'
    del.title = 'Remove'
    del.addEventListener('click', async () => {
      const res = await api.deletePreset(currentCharacterId, preset.id)
      if (res.ok) {
        customPresets = res.list
        if (editingPresetId === preset.id) cancelEditPreset()
        renderPresets()
      }
    })
    row.appendChild(del)
  }
  return row
}

export function renderPresets() {
  const box = $('presetsList')
  box.innerHTML = ''
  for (const preset of BUILTIN_PRESETS) box.appendChild(presetRow(preset, false))
  for (const preset of customPresets) box.appendChild(presetRow(preset, true))
  renderDirectivePresets()
}

/// One-click chips above the Dispatch input — same presets as the drawer,
/// same immediate-send behavior as clicking a preset row there.
function renderDirectivePresets() {
  const box = $('directivePresets')
  box.innerHTML = ''
  for (const preset of [...BUILTIN_PRESETS, ...customPresets]) {
    const chip = document.createElement('button')
    chip.type = 'button'
    chip.className = 'chip directive-preset-chip'
    chip.textContent = preset.name
    chip.title = preset.prompt
    chip.addEventListener('click', () => sendDirective(preset.prompt))
    box.appendChild(chip)
  }
}

function startEditPreset(preset) {
  editingPresetId = preset.id
  $('presetName').value = preset.name
  $('presetPrompt').value = preset.prompt
  $('presetsSubmit').textContent = 'Save'
  $('presetsCancelEdit').hidden = false
}

function cancelEditPreset() {
  editingPresetId = null
  $('presetsForm').reset()
  $('presetsSubmit').textContent = 'Add'
  $('presetsCancelEdit').hidden = true
}

/// Wires every form/button this module owns: the drawers' Add/Edit/Delete
/// forms, and the main Dispatch input (same send-and-track path as a
/// coordinate or preset click). `getLastSelf` reads the agent's last known
/// position for "Use current position" — vitals tracking stays in app.js.
export function bind({ getLastSelf }) {
  $('directiveForm').addEventListener('submit', async (e) => {
    e.preventDefault()
    const input = $('directiveInput')
    const text = input.value.trim()
    if (!text) return
    input.value = ''
    await sendDirective(text)
  })

  $('coordUseCurrent').addEventListener('click', () => {
    const self = getLastSelf()
    if (!self?.position) return
    $('coordName').value = self.name || ''
    $('coordX').value = self.position.x.toFixed(1)
    $('coordY').value = self.position.y.toFixed(1)
    $('coordZ').value = self.position.z.toFixed(1)
  })

  $('coordsForm').addEventListener('submit', async (e) => {
    e.preventDefault()
    const name = $('coordName').value.trim()
    const x = Number($('coordX').value)
    const y = Number($('coordY').value)
    const z = Number($('coordZ').value)
    if (!name || !currentCharacterId || [x, y, z].some(Number.isNaN)) return
    const res = await api.addCoordinate(currentCharacterId, { name, x, y, z })
    if (!res.ok) {
      showErrors([res.error])
      return
    }
    customCoords = res.list
    renderCoords()
    e.target.reset()
  })

  $('presetsForm').addEventListener('submit', async (e) => {
    e.preventDefault()
    const name = $('presetName').value.trim()
    const prompt = $('presetPrompt').value.trim()
    if (!name || !prompt || !currentCharacterId) return
    const res = editingPresetId
      ? await api.updatePreset(currentCharacterId, editingPresetId, { name, prompt })
      : await api.addPreset(currentCharacterId, { name, prompt })
    if (!res.ok) {
      showErrors([res.error])
      return
    }
    customPresets = res.list
    renderPresets()
    cancelEditPreset()
  })

  $('presetsCancelEdit').addEventListener('click', () => cancelEditPreset())
}
