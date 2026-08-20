'use strict'

const fs = require('node:fs')
const path = require('node:path')

/// Every language the UI offers, labelled in itself — a language nobody can
/// read is not a choice. `en` has no dictionary: the English original is the
/// lookup key, so a missing entry renders the English it already is.
const LANGUAGES = [
  { id: 'en', label: 'English' },
  { id: 'zh-TW', label: '繁體中文' },
  { id: 'ko', label: '한국어' },
]

const cache = new Map()
let current = 'en'

/// The UI language for an OS locale. Simplified Chinese (zh-CN, zh-SG) falls
/// through to English rather than being handed Traditional text.
function resolveLocale(locale) {
  const tag = String(locale || '')
    .toLowerCase()
    .replace(/_/g, '-')
  if (tag.startsWith('ko')) return 'ko'
  if (/^zh-(tw|hant|hk|mo)/.test(tag)) return 'zh-TW'
  return 'en'
}

function dictionary(language) {
  if (language === 'en') return {}
  if (cache.has(language)) return cache.get(language)
  let dict = {}
  try {
    dict = JSON.parse(fs.readFileSync(path.join(__dirname, 'locales', `${language}.json`), 'utf8'))
  } catch {
    // A missing or malformed dictionary reads as English rather than keeping
    // the app from starting.
  }
  cache.set(language, dict)
  return dict
}

/// `{name}` placeholders, applied to the translation *and* to the English
/// fallback, so a key without an entry still reads as a finished sentence.
function interpolate(text, params) {
  if (!params) return text
  return text.replace(/\{(\w+)\}/g, (whole, name) =>
    Object.hasOwn(params, name) ? String(params[name]) : whole,
  )
}

function setLanguage(language) {
  current = LANGUAGES.some((l) => l.id === language) ? language : 'en'
  return current
}

function language() {
  return current
}

function t(key, params) {
  const entry = dictionary(current)[key]
  return interpolate(typeof entry === 'string' && entry ? entry : key, params)
}

module.exports = { LANGUAGES, resolveLocale, dictionary, interpolate, setLanguage, language, t }
