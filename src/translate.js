'use strict'

const { httpEndpoint } = require('./backends')

const TIMEOUT_MS = 10000

function systemPrompt(target) {
  return (
    `You are a translation engine for live chat in a multiplayer fantasy game. ` +
    `Output ONLY the translation of the user message into ${target}. ` +
    `Keep it short and colloquial. No explanations, no alternatives, ` +
    `no romanization, no markdown, no quotes.`
  )
}

/// Where a translation call goes. The agent's own endpoint when it is asked to
/// share one and that backend has one to share — a CLI backend does not, so
/// this falls back to the fields typed under the checkbox rather than failing.
/// Resolved per call, never copied into the settings file.
function provider(settings) {
  if (!settings) return null
  const shared = settings.translateUseLlmProvider ? httpEndpoint(settings) : null
  const endpoint = shared || {
    base: String(settings.translateBaseUrl || '').replace(/\/+$/, ''),
    model: settings.translateModel,
    key: settings.translateKey,
  }
  return endpoint.base && endpoint.model ? endpoint : null
}

function isConfigured(settings) {
  return provider(settings) !== null
}

async function translateText(settings, { text, target }, adapters = {}) {
  const endpoint = provider(settings)
  if (!endpoint) return { ok: false, error: 'No translation endpoint configured' }
  if (!text || !target) return { ok: false, error: 'Nothing to translate' }

  const request = adapters.fetch || fetch
  const headers = { 'content-type': 'application/json' }
  if (endpoint.key) headers.authorization = `Bearer ${endpoint.key}`

  try {
    const response = await request(`${endpoint.base}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: endpoint.model,
        temperature: 0,
        messages: [
          { role: 'system', content: systemPrompt(target) },
          { role: 'user', content: text },
        ],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) {
      const detail = typeof response.text === 'function' ? (await response.text()).slice(0, 300) : ''
      return { ok: false, error: `Translation returned HTTP ${response.status}${detail ? `: ${detail}` : ''}` }
    }
    const body = await response.json()
    const content = body?.choices?.[0]?.message?.content
    if (typeof content !== 'string' || !content.trim()) {
      return { ok: false, error: 'Translation endpoint returned no text' }
    }
    // A model that ignores the "translation only" instruction answers with a
    // multi-option essay instead. Observed on a real endpoint whose structured
    // output preset was switched off mid-session.
    const translated = content.trim()
    if (translated.length > text.length * 10 + 100) {
      return { ok: false, error: 'Translation endpoint returned an explanation, not a translation' }
    }
    return { ok: true, text: translated }
  } catch (error) {
    return { ok: false, error: `Translation failed: ${error.message}` }
  }
}

module.exports = { translateText, isConfigured }
