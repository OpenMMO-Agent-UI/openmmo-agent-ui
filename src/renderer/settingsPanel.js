'use strict'

import { $, readField } from './dom.js'
import { applyToastCssVars } from './actionToasts.js'

const ACTIVE_CADENCES = [
  ['Very fast', 3],
  ['Fast', 5],
  ['Balanced', 10],
  ['Relaxed', 20],
  ['Economical', 30],
]
const IDLE_CADENCES = [
  ['Frequent', 30],
  ['Normal', 60],
  ['Occasional', 300],
  ['Rare', 900],
  ['Minimum', 3600],
]

export function nearestCadenceIndex(options, seconds) {
  let best = 0
  for (let i = 1; i < options.length; i++) {
    if (Math.abs(options[i][1] - seconds) < Math.abs(options[best][1] - seconds)) best = i
  }
  return best
}

function renderCadenceLabels() {
  const active = ACTIVE_CADENCES[Number($('activeCadence').value)]
  const idle = IDLE_CADENCES[Number($('idleCadence').value)]
  $('activeCadenceLabel').textContent = `${active[0]} · ${active[1]} seconds`
  $('activeCadenceHint').textContent = `At most about ${(60 / active[1]).toFixed(1)} calls/minute while active.`
  $('idleCadenceLabel').textContent =
    `${idle[0]} · ${idle[1] >= 60 ? `${idle[1] / 60} minute${idle[1] === 60 ? '' : 's'}` : `${idle[1]} seconds`}`
  $('idleCadenceHint').textContent = `At most about ${(60 / idle[1]).toFixed(2)} calls/minute while quiet.`
}

/// Cadence sliders persist through the Apply-gated flow (like the rest of
/// the Agent tab's FIELDS), unlike toast/audio below — so this is exported
/// separately for closeSettings' snapshot revert, which must not touch the
/// immediate-persist controls.
export function syncCadence(settings) {
  $('activeCadence').value = nearestCadenceIndex(ACTIVE_CADENCES, settings.minIntervalSecs)
  $('idleCadence').value = nearestCadenceIndex(IDLE_CADENCES, settings.idleIntervalSecs)
  renderCadenceLabels()
}

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
  $('bgmVolumeLabel').textContent = settings.bgmMuted ? 'Muted' : `${settings.bgmVolume}%`
  $('sfxVolumeLabel').textContent = settings.sfxMuted ? 'Muted' : `${settings.sfxVolume}%`
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

/// Called when the Settings modal opens: mirrors current settings onto the
/// cadence/toast/audio controls. Unlike syncCadence, toast/audio never need
/// a revert path — they're saved on every change, so there's nothing to
/// snap back to.
export function syncAll(settings) {
  syncCadence(settings)
  syncToast(settings)
  syncAudio(settings)
}

/// Wires every cadence/toast/audio control. `getSettings` is read fresh on
/// every event rather than captured once, since app.js may reassign
/// `settings` wholesale (a save round-trip, or a snapshot revert) between
/// bind() and any later interaction. `onCadenceChange` routes through the
/// Apply-gated dirty flow; `onImmediateChange` saves on every change.
export function bind({ getSettings, onCadenceChange, onImmediateChange }) {
  $('activeCadence').addEventListener('input', () => {
    const value = ACTIVE_CADENCES[Number($('activeCadence').value)][1]
    $('minIntervalSecs').value = value
    onCadenceChange({ minIntervalSecs: value })
    renderCadenceLabels()
  })
  $('idleCadence').addEventListener('input', () => {
    const value = IDLE_CADENCES[Number($('idleCadence').value)][1]
    $('idleIntervalSecs').value = value
    onCadenceChange({ idleIntervalSecs: value })
    renderCadenceLabels()
  })

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
