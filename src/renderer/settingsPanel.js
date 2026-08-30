'use strict'

import { $, readField } from './dom.js'
import { applyToastCssVars } from './actionToasts.js'
import { t } from './i18n.js'

function renderToastLabels(settings) {
  $('toastFontSizeLabel').textContent = `${settings.toastFontSize}px`
  $('toastOpacityLabel').textContent = `${settings.toastOpacity}%`
  $('toastPersistSecsLabel').textContent = `${settings.toastPersistSecs}s`
  $('toastFadeSecsLabel').textContent = `${settings.toastFadeSecs}s`
  $('toastMaxCountLabel').textContent = String(settings.toastMaxCount)
}

function syncToast(settings) {
  $('toastFontSize').value = settings.toastFontSize
  $('toastOpacity').value = settings.toastOpacity
  $('toastPersistSecs').value = settings.toastPersistSecs
  $('toastFadeSecs').value = settings.toastFadeSecs
  $('toastMaxCount').value = settings.toastMaxCount
  renderToastLabels(settings)
}

function renderAudioLabels(settings) {
  $('bgmVolumeLabel').textContent = settings.bgmMuted ? t('Muted') : `${settings.bgmVolume}%`
  $('sfxVolumeLabel').textContent = settings.sfxMuted ? t('Muted') : `${settings.sfxVolume}%`
}

/// The game client's own BGM/SFX volume lives in its iframe's separate
/// origin (127.0.0.1) — nothing here to relay a change into without a live
/// spectator view, so the controls are disabled rather than lying about
/// having an effect.
export function updateAudioAvailability() {
  const available = Boolean($('frame').dataset.url)
  for (const id of ['bgmVolume', 'bgmMuted', 'sfxVolume', 'sfxMuted']) $(id).disabled = !available
  $('audioUnavailable').hidden = available
}

function syncAudio(settings) {
  $('bgmVolume').value = settings.bgmVolume
  $('bgmMuted').checked = settings.bgmMuted
  $('sfxVolume').value = settings.sfxVolume
  $('sfxMuted').checked = settings.sfxMuted
  renderAudioLabels(settings)
  updateAudioAvailability()
}

/// Pushed on every audio-control change and every time the spectator frame
/// (re)loads — cross-origin, so this postMessage is the only way in (see
/// App.svelte's matching listener in the fork).
export function sendAudioToView(settings) {
  const frame = $('frame')
  if (!frame.dataset.url || !frame.contentWindow) return
  frame.contentWindow.postMessage(
    {
      type: 'openmmo-set-audio',
      bgmVolume: settings.bgmVolume / 100,
      bgmMuted: settings.bgmMuted,
      sfxVolume: settings.sfxVolume / 100,
      sfxMuted: settings.sfxMuted,
    },
    '*',
  )
}

function sameSpot(a, b) {
  return Math.abs(a.x - b.x) < 0.05 && Math.abs(a.z - b.z) < 0.05
}

/// The spots the fighter can be anchored to — the four the world is built
/// around, named so the dropdown reads as places rather than numbers.
const ANCHOR_SPOTS = [
  { name: 'Aldermark', x: -1471.4, y: 0.9, z: 4741.2 },
  { name: 'Old Crypt', x: -1450, y: 0.7, z: 4720 },
  { name: 'Orc Warrens', x: -1616, y: 1.05, z: 4918 },
  { name: 'Ogre Stronghold', x: -1785.2, y: 1.4, z: 5072.3 },
]

/// The fighter's Anchor dropdown: index 0 is always "no anchor picked" (the
/// world's spawn point), then the spots above, and last the stored anchor when
/// the list no longer holds it — an anchor the player picked must not silently
/// reset because it is not one of the named spots.
///
/// What settings hold is a snapshot; the name is only what this shows.
export function anchorChoices(settings, saved = ANCHOR_SPOTS) {
  // `Number(null)` is 0, so an unset anchor would read as a real spot at the
  // world's origin — and show as one, picked, in place of the spawn point.
  const coord = (value) => (value === '' || value == null ? null : Number(value))
  const [x, z] = [coord(settings.workerAnchorX), coord(settings.workerAnchorZ)]
  const anchor =
    Number.isFinite(x) && Number.isFinite(z) ? { name: settings.workerAnchorName || '', x, z } : null
  const choices = [null, ...saved]
  if (anchor && !choices.some((c) => c && sameSpot(c, anchor))) choices.push(anchor)
  const at = choices.findIndex((c) => (anchor ? c && sameSpot(c, anchor) : !c))
  return { choices, selected: at < 0 ? 0 : at }
}

/// Called when the Settings modal opens: mirrors current settings onto the
/// toast/audio controls. They need no revert path — every one of them saves on
/// change, so there is nothing to snap back to.
export function syncAll(settings) {
  syncToast(settings)
  syncAudio(settings)
}

/// Wires every toast/audio control. `getSettings` is read fresh on every event
/// rather than captured once, since app.js may reassign `settings` wholesale
/// (a save round-trip, or a snapshot revert) between bind() and any later
/// interaction. Everything here saves on change.
export function bind({ getSettings, onImmediateChange }) {
  const toastFields = {
    toastFontSize: 'int',
    toastOpacity: 'int',
    toastPersistSecs: 'int',
    toastFadeSecs: 'float',
    toastMaxCount: 'int',
  }
  for (const [id, type] of Object.entries(toastFields)) {
    $(id).addEventListener('input', () => {
      onImmediateChange({ [id]: readField(id, type) })
      const settings = getSettings()
      renderToastLabels(settings)
      applyToastCssVars(settings)
    })
  }

  for (const id of ['bgmVolume', 'sfxVolume']) {
    $(id).addEventListener('input', () => {
      onImmediateChange({ [id]: readField(id, 'int') })
      const settings = getSettings()
      renderAudioLabels(settings)
      sendAudioToView(settings)
    })
  }
  for (const id of ['bgmMuted', 'sfxMuted']) {
    $(id).addEventListener('change', () => {
      onImmediateChange({ [id]: $(id).checked })
      const settings = getSettings()
      renderAudioLabels(settings)
      sendAudioToView(settings)
    })
  }
}
