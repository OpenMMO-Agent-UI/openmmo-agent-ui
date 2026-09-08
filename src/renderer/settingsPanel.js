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

export function sameSpot(a, b) {
  return Math.abs(a.x - b.x) < 0.05 && Math.abs(a.z - b.z) < 0.05
}

/// A coordinate a text field holds, or null when the field is empty or not a
/// number. `Number(null)` is 0, so an unset anchor would otherwise read as a
/// real spot at the world's origin.
function coord(value) {
  if (value === '' || value == null) return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

/// A spot the player typed, or null when it is not a usable one. The name is
/// only a label, so an unnamed spot is still a spot.
export function anchorSpot(name, x, z) {
  const [px, pz] = [coord(x), coord(z)]
  if (px == null || pz == null) return null
  return { name: String(name || '').trim(), x: px, z: pz }
}

/// The saved list with `spot` in it, replacing whatever already stood there —
/// a name saved twice moves the pin rather than growing a second entry with
/// the same label.
export function withAnchorSpot(saved, spot) {
  const kept = (saved || []).filter((c) => !sameSpot(c, spot) && (c.name || '') !== spot.name)
  return [...kept, spot]
}

/// The saved list without the spot standing at `spot`.
export function withoutAnchorSpot(saved, spot) {
  return (saved || []).filter((c) => !sameSpot(c, spot))
}

/// The fighter's Anchor dropdown: index 0 is always "no anchor picked" (the
/// world's spawn point), then the player's own saved spots, and last the
/// stored anchor when the list no longer holds it — an anchor the player
/// picked must not silently reset because its spot was deleted or imported
/// from a config.toml.
///
/// What settings hold is a snapshot; the name is only what this shows.
export function anchorChoices(settings, saved = settings.workerAnchors || []) {
  const { workerAnchorName, workerAnchorX, workerAnchorZ } = settings
  const anchor = anchorSpot(workerAnchorName, workerAnchorX, workerAnchorZ)
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
