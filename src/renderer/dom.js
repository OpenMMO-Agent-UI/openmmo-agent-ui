'use strict'

export const $ = (id) => document.getElementById(id)

/// A `min`/`max` attribute as a number. `Number('')` is 0, so an absent
/// attribute has to be caught before the numeric check.
function bound(raw, fallback) {
  if (raw === '' || raw == null) return fallback
  const value = Number(raw)
  return Number.isFinite(value) ? value : fallback
}

/// Nothing here submits a form or calls `checkValidity()`, so the browser
/// never enforces `min`/`max`. Applied on read instead.
export function clampToBounds(value, min, max) {
  return Math.min(Math.max(value, bound(min, -Infinity)), bound(max, Infinity))
}

/// Empty, or a 0 in a field that floors higher, is an unfinished edit rather
/// than a value — clamping it would silently write the floor (Maximum tokens
/// cleared would become `max_tokens = 1`). A real floor of 0 keeps its 0.
export function isAnswered(raw, min) {
  const text = String(raw == null ? '' : raw).trim()
  if (text === '') return false
  return Number(text) !== 0 || bound(min, 0) <= 0
}

export function readField(id, type) {
  const el = $(id)
  if (type === 'bool') return el.checked
  if (type === 'int') return clampToBounds(parseInt(el.value, 10) || 0, el.min, el.max)
  if (type === 'float') return clampToBounds(parseFloat(el.value) || 0, el.min, el.max)
  return el.value
}

export function writeField(id, type, value) {
  const el = $(id)
  if (!el) return
  if (type === 'bool') el.checked = Boolean(value)
  else el.value = value == null ? '' : value
}

/// One shared toast for whichever screen is showing — Play/Restart failures
/// alike, so an error never depends on which screen happened to trigger it.
export function showErrors(errors) {
  const box = $('errors')
  const list = errors || []
  box.hidden = list.length === 0
  box.textContent = list.map((e) => `• ${e}`).join('\n')
}

/// Drives `body[data-screen]`, the single source of which screen is visible.
export function setScreen(name) {
  document.body.dataset.screen = name
}

/// A destructive action's one guard: resolves true only if Delete is
/// clicked, false for Cancel or dismissing any other way.
export function confirmAction(message, okLabel = 'Delete') {
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
