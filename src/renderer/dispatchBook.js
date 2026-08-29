'use strict'

import { $, showErrors } from './dom.js'
import { t } from './i18n.js'

const api = window.agentApp

/// A directive: best-effort, so its reply is tracked and shown
/// right next to what was sent rather than assumed to have landed.
let pendingDirective = null

/// Records what was sent so the reply (below) can be matched back to it.
export function trackDirective(text) {
  pendingDirective = { text, sentAt: Date.now() }
  $('directiveSent').textContent = text
  $('directiveReply').textContent = t('waiting…')
  $('directiveLog').hidden = false
  // The one deliberate animation moment (see style.css) — a brief ember
  // pulse marking that word was actually sent.
  const panel = $('directivePanel')
  panel.classList.add('sent')
  setTimeout(() => panel.classList.remove('sent'), 900)
}

/// Best-effort, not guaranteed: show the agent's next turn right
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

/// The Dispatch input: send what was typed, and track it so the agent's next
/// turn can be shown as the reply.
export function bind() {
  $('directiveForm').addEventListener('submit', async (e) => {
    e.preventDefault()
    const input = $('directiveInput')
    const text = input.value.trim()
    if (!text) return
    input.value = ''
    await sendDirective(text)
  })
}
