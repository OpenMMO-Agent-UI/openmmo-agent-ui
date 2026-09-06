'use strict'

const { httpEndpoint } = require('../backends')

const TIMEOUT_MS = 10000
const MAX_RESPONSE_BYTES = 256 * 1024
const MAX_PATCH_OPERATIONS = 100
const ALLOWED_OPS = new Set(['add', 'replace', 'remove'])

const SYSTEM_PROMPT =
  'You produce edits for an openmmo-worker v1 document. Output only one JSON object ' +
  '`{summary:string, patch: RFC6902-op[]}`. Patch operations may only be add, replace, or remove. ' +
  'Never emit arbitrary code or eval, prototype keys, secrets, credentials, memory, snapshots, ' +
  'or unsupported actions.'

function isValidPath(path) {
  if (typeof path !== 'string' || (path !== '' && !path.startsWith('/'))) return false
  return path.split('/').slice(1).every((part) => {
    if (/~(?:[^01]|$)/.test(part)) return false
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~').toLowerCase()
    return key !== '__proto__' && key !== 'prototype' && key !== 'constructor'
  })
}

function isValidResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false
  if (typeof result.summary !== 'string' || !Array.isArray(result.patch)) return false
  if (result.patch.length > MAX_PATCH_OPERATIONS) return false
  if (!Object.keys(result).every((key) => key === 'summary' || key === 'patch')) return false
  return result.patch.every((operation) => {
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) return false
    if (!ALLOWED_OPS.has(operation.op) || !isValidPath(operation.path)) return false
    const keys = Object.keys(operation)
    if (operation.op === 'remove') return keys.length === 2 && keys.includes('op') && keys.includes('path')
    return (
      keys.length === 3 &&
      keys.includes('op') &&
      keys.includes('path') &&
      Object.prototype.hasOwnProperty.call(operation, 'value')
    )
  })
}

function boundedDetail(value, key) {
  let detail = String(value || '').replace(/\s+/g, ' ').trim()
  if (key) detail = detail.split(key).join('[redacted]')
  return detail.slice(0, 300)
}

async function buildWorkerPatch(settings, input = {}, adapters = {}) {
  input = input || {}
  const endpoint = settings ? httpEndpoint(settings) : null
  if (!endpoint) return { ok: false, error: 'Worker Studio requires a configured HTTP backend' }
  if (!endpoint.base || !endpoint.model) {
    return { ok: false, error: 'Worker Studio HTTP backend is not configured' }
  }
  if (typeof input.message !== 'string' || !input.message.trim()) {
    return { ok: false, error: 'Worker Studio customization message is empty' }
  }
  if (
    !input.document ||
    typeof input.document !== 'object' ||
    Array.isArray(input.document)
  ) {
    return { ok: false, error: 'Worker Studio document is missing' }
  }

  let document
  try {
    document = JSON.stringify(input.document, null, 2)
  } catch {
    return { ok: false, error: 'Worker Studio document is not serializable' }
  }

  const headers = { 'content-type': 'application/json' }
  if (endpoint.key) headers.authorization = `Bearer ${endpoint.key}`
  const request = adapters.fetch || fetch

  try {
    const response = await request(`${endpoint.base}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: endpoint.model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: `Current document:\n${document}\n\nCustomization request:\n${input.message.trim()}`,
          },
        ],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) {
      const rawDetail = typeof response.text === 'function' ? await response.text() : ''
      const detail = boundedDetail(rawDetail, endpoint.key)
      return {
        ok: false,
        error: `Worker Studio returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
      }
    }
    const body = await response.json()
    const content = body?.choices?.[0]?.message?.content
    if (typeof content !== 'string' || !content.trim()) {
      return { ok: false, error: 'Worker Studio provider returned no patch' }
    }
    const text = content.trim()
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
      return { ok: false, error: 'Worker Studio response is too large' }
    }
    const fenced = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i)
    let result
    try {
      result = JSON.parse(fenced ? fenced[1] : text)
    } catch {
      return { ok: false, error: 'Worker Studio provider returned malformed JSON' }
    }
    if (Array.isArray(result?.patch) && result.patch.length > MAX_PATCH_OPERATIONS) {
      return { ok: false, error: 'Worker Studio patch exceeds the operation limit' }
    }
    if (!isValidResult(result)) {
      return { ok: false, error: 'Worker Studio provider returned an invalid patch' }
    }
    return { ok: true, summary: result.summary, patch: result.patch }
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError'
    const reason = boundedDetail(error?.message || error, endpoint.key)
    return {
      ok: false,
      error: timedOut
        ? `Worker Studio request timed out${reason ? `: ${reason}` : ''}`
        : `Worker Studio failed${reason ? `: ${reason}` : ''}`,
    }
  }
}

module.exports = { buildWorkerPatch }
