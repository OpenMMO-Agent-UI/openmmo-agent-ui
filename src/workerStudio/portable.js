'use strict'

const OMIT = Symbol('omit')
const SENSITIVE_KEY = /(?:api[_-]?key|token|secret|credential|password|passwd|memory|snapshot)/i
const SENSITIVE_VALUE = /^(?:sk-[A-Za-z0-9_-]+|(?:bearer\s+).+|(?:api[_ -]?key|token|secret|credential|password)\s*[:=].+)$/i
const ABSOLUTE_PATH = /^(?:\/|~\/|[A-Za-z]:[\\/]|file:\/\/)/

function sanitize(value, key = '') {
  if (SENSITIVE_KEY.test(key)) return OMIT
  if (typeof value === 'string' && (ABSOLUTE_PATH.test(value) || SENSITIVE_VALUE.test(value))) return OMIT
  if (Array.isArray(value)) {
    return value.map((entry) => sanitize(entry)).filter((entry) => entry !== OMIT)
  }
  if (!value || typeof value !== 'object') return value
  const result = {}
  for (const entryKey of Object.keys(value).sort()) {
    const entry = sanitize(value[entryKey], entryKey)
    if (entry !== OMIT) result[entryKey] = entry
  }
  return result
}

function portableDocument(input) {
  const source = input && typeof input === 'object' ? input : {}
  const metadata = sanitize({
    ...(Object.hasOwn(source.metadata || {}, 'name') ? { name: source.metadata.name } : {}),
    ...(Object.hasOwn(source.metadata || {}, 'description') ? { description: source.metadata.description } : {}),
  })
  const rules = Array.isArray(source.rules) ? source.rules.map((rule) => sanitize({
    ...(Object.hasOwn(rule || {}, 'id') ? { id: rule.id } : {}),
    ...(Object.hasOwn(rule || {}, 'priority') ? { priority: rule.priority } : {}),
    ...(Object.hasOwn(rule || {}, 'condition') ? { condition: rule.condition } : {}),
    ...(Object.hasOwn(rule || {}, 'actions') ? { actions: rule.actions } : {}),
  })) : []
  return sanitize({
    format: source.format,
    metadata,
    rules,
    version: source.version,
  })
}

function assertValid(document, validateDocument) {
  const errors = validateDocument(document)
  if (errors.length) {
    const error = new Error(`invalid portable worker: ${errors[0].path} ${errors[0].message}`)
    error.errors = errors
    throw error
  }
  return document
}

function exportPortableDocument(input, validateDocument) {
  const portable = portableDocument(input)
  if (validateDocument) assertValid(portable, validateDocument)
  return `${JSON.stringify(portable, null, 2)}\n`
}

function importPortableDocument(input, validateDocument) {
  const parsed = typeof input === 'string' ? JSON.parse(input) : input
  const portable = portableDocument(parsed)
  return validateDocument ? assertValid(portable, validateDocument) : portable
}

module.exports = { portableDocument, exportPortableDocument, importPortableDocument }
