'use strict'

import { $ } from './dom.js'

function toastTtlMs(settings) {
  return (settings?.toastPersistSecs ?? 7) * 1000
}
function toastFadeMs(settings) {
  return (settings?.toastFadeSecs ?? 0.4) * 1000
}
function toastMaxCount(settings) {
  return settings?.toastMaxCount ?? 10
}

/// Pushes the settings-configurable toast look (font size, background
/// transparency, fade duration) onto :root so every `.action-toast` —
/// including the live preview in Settings — picks it up without threading
/// the values through per-element inline styles.
export function applyToastCssVars(settings) {
  document.documentElement.style.setProperty('--toast-font-size', `${settings.toastFontSize}px`)
  document.documentElement.style.setProperty('--toast-bg-opacity', String(settings.toastOpacity / 100))
  document.documentElement.style.setProperty('--toast-fade-ms', `${toastFadeMs(settings)}ms`)
}

/// One label per parsed AgentAction (agent-client/src/driver/action.rs),
/// shown next to the clock in the gamebar header.
export function actionLabel(action, monsterNames) {
  if (!action || typeof action !== 'object') return ''
  switch (action.type) {
    case 'say': {
      const msg = String(action.message ?? '')
      return `Say "${msg.length > 24 ? `${msg.slice(0, 24)}…` : msg}"`
    }
    case 'attack': {
      const id = action.monster_id ?? action.target ?? action.id ?? '?'
      return `Attack→${monsterNames.get(id) ?? id}`
    }
    case 'move':
      if (action.target) return `Move→${action.target}`
      if (action.x != null || action.z != null) {
        const x = action.x != null ? Math.round(action.x) : '?'
        const z = action.z != null ? Math.round(action.z) : '?'
        return `Move→(${x}, ${z})`
      }
      if (action.direction) return `Move→${action.direction}${action.distance != null ? ` ${action.distance}m` : ''}`
      if (action.depth != null) return `Move→floor ${action.depth}`
      return 'Move'
    case 'respawn':
      return 'Respawn'
    case 'fish':
      return 'Fish'
    case 'stop_fishing':
      return 'Stop fishing'
    case 'offer_deal':
      return `Offer→${action.item ?? '?'}${action.player ? ` to ${action.player}` : ''}`
    case 'open_trade':
      return `Trade→${action.player ?? '?'}`
    case 'party_invite':
      return `Invite→${action.player ?? '?'}`
    case 'party_accept':
      return 'Accept party'
    case 'party_decline':
      return 'Decline party'
    case 'party_leave':
      return 'Leave party'
    case 'use':
      return `Use→${action.item ?? '?'}`
    case 'pickup':
      return `Pickup→${action.item ?? '?'}`
    case 'sell':
      return `Sell→${action.item ?? '?'}`
    case 'buy':
      return `Buy→${action.item ?? '?'}`
    case 'drop':
      return `Drop→${action.item ?? '?'}`
    case 'buyback':
      return `Buyback→${action.item ?? '?'}`
    case 'break_prop':
      return `Break→prop ${action.prop_id ?? action.id ?? '?'}`
    case 'open_chest':
      return action.chest ? `Open chest→${action.chest}` : 'Open chest'
    case 'reroll':
      return 'Reroll'
    case 'wait':
      return 'Wait'
    default:
      return action.type ? String(action.type) : ''
  }
}

/// A serialized signature of whichever `actions` array the last push()
/// call already toasted. main.js resends the same actions every poll tick
/// until a new turn lands — but each send crosses the main/renderer IPC
/// boundary, which structured-clones the payload, so the renderer never
/// receives the same array *instance* twice even when nothing changed.
/// Comparing content instead of identity is what actually tells a genuinely
/// new turn apart from the same stale value arriving again.
let lastToastedActionsSignature = null

/// Toast element -> its pending fade/remove timers, so a repeat of the same
/// action (see pushOne) can cancel and restart them instead of leaving the
/// old ones to fire early on a toast that just got reused.
const actionToastTimers = new Map()

function scheduleToastRemoval(el, settings) {
  const prev = actionToastTimers.get(el)
  if (prev) {
    clearTimeout(prev.fadeTimer)
    clearTimeout(prev.removeTimer)
  }
  el.classList.remove('out')
  const ttl = toastTtlMs(settings)
  const fade = toastFadeMs(settings)
  actionToastTimers.set(el, {
    fadeTimer: setTimeout(() => el.classList.add('out'), Math.max(0, ttl - fade)),
    removeTimer: setTimeout(() => {
      actionToastTimers.delete(el)
      el.remove()
    }, ttl),
  })
}

/// A repeated action (e.g. "Move→north" every turn while walking) collapses
/// into the most recent toast instead of stacking a new one — otherwise a
/// long walk reads as a wall of identical notifications.
function pushOne(text, settings) {
  const box = $('actionToasts')
  const last = box.lastElementChild
  if (last && last.dataset.label === text) {
    const count = Number(last.dataset.count) + 1
    last.dataset.count = String(count)
    last.textContent = `${text} ×${count}`
    scheduleToastRemoval(last, settings)
    return
  }
  const el = document.createElement('div')
  el.className = 'action-toast'
  el.textContent = text
  el.dataset.label = text
  el.dataset.count = '1'
  box.appendChild(el)
  while (box.childElementCount > toastMaxCount(settings)) box.removeChild(box.firstChild)
  scheduleToastRemoval(el, settings)
}

export function push(settings, actions, monsterNames) {
  const signature = Array.isArray(actions) ? JSON.stringify(actions) : ''
  if (signature === lastToastedActionsSignature) return
  lastToastedActionsSignature = signature
  if (!Array.isArray(actions)) return
  for (const action of actions) {
    const label = actionLabel(action, monsterNames)
    if (label) pushOne(label, settings)
  }
}

export function clear() {
  for (const { fadeTimer, removeTimer } of actionToastTimers.values()) {
    clearTimeout(fadeTimer)
    clearTimeout(removeTimer)
  }
  actionToastTimers.clear()
  $('actionToasts').innerHTML = ''
  lastToastedActionsSignature = null
}
