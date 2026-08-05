'use strict'

export const $ = (id) => document.getElementById(id)

export function readField(id, type) {
  const el = $(id)
  if (type === 'bool') return el.checked
  if (type === 'int') return parseInt(el.value, 10) || 0
  if (type === 'float') return parseFloat(el.value) || 0
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
