'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { LANGUAGES, resolveLocale, dictionary, interpolate, setLanguage, t } = require('../src/i18n')

const SRC = path.join(__dirname, '..', 'src')
const TRANSLATED = LANGUAGES.filter((l) => l.id !== 'en').map((l) => l.id)

function decodeEntities(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
}

/// Every key the markup asks for: the text nodes under `data-i18n` and the
/// attribute values named by `data-i18n-attr`. Reads the same way applyI18n
/// does — direct child text nodes only, whitespace collapsed.
function markupKeys(html) {
  const keys = new Set()
  const SPLIT = String.fromCharCode(0)
  const TAG = /<([a-zA-Z0-9]+)\b([^>]*\bdata-i18n(?:-attr="([^"]*)")?[^>]*)>/g
  let match
  while ((match = TAG.exec(html))) {
    const [whole, tag, attrs, attrList] = match
    for (const name of (attrList || '').split(',').map((n) => n.trim()).filter(Boolean)) {
      const found = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)
      if (found) keys.add(decodeEntities(found[1]))
    }
    if (!/\bdata-i18n(?=[\s>]|$)/.test(attrs) || whole.endsWith('/>')) continue
    const close = html.indexOf(`</${tag}>`, TAG.lastIndex)
    const inner = html.slice(TAG.lastIndex, close === -1 ? TAG.lastIndex : close)
    const direct = inner.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, SPLIT).replace(/<[^>]+>/g, SPLIT)
    for (const part of direct.split(SPLIT)) {
      const key = part.trim().replace(/\s+/g, ' ')
      if (key) keys.add(decodeEntities(key))
    }
  }
  return keys
}

/// Literal `t('…')` / `i18n.t('…')` arguments, concatenated pieces included.
/// A key passed as a variable (a lookup table's value) is invisible here —
/// those are covered by the two dictionaries having to agree, below.
const CALL =
  /(?:\bi18n\.t|(?<![.\w])t)\(\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")((?:\s*\+\s*(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"))*)/g

function unquote(literal) {
  const body = literal.slice(1, -1)
  return literal[0] === "'"
    ? body.replace(/\\'/g, "'").replace(/\\\\/g, '\\')
    : body.replace(/\\"/g, '"').replace(/\\\\/g, '\\')
}

function sourceKeys(dir, keys = new Set()) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      sourceKeys(file, keys)
      continue
    }
    if (!entry.name.endsWith('.js') || entry.name === 'i18n.js') continue
    const source = fs.readFileSync(file, 'utf8')
    let match
    CALL.lastIndex = 0
    while ((match = CALL.exec(source))) {
      let key = unquote(match[1])
      for (const piece of match[2].match(/('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g) || []) {
        key += unquote(piece)
      }
      keys.add(key)
    }
  }
  return keys
}

function allKeys() {
  const html = fs.readFileSync(path.join(SRC, 'renderer', 'index.html'), 'utf8')
  return new Set([...markupKeys(html), ...sourceKeys(SRC)])
}

function placeholders(text) {
  return (text.match(/\{\w+\}/g) || []).sort()
}

test('the markup and the source between them ask for keys every dictionary has', () => {
  const wanted = [...allKeys()].sort()
  assert.ok(wanted.length > 100, `expected the whole UI, found ${wanted.length} keys`)
  for (const id of TRANSLATED) {
    const dict = dictionary(id)
    const missing = wanted.filter((key) => typeof dict[key] !== 'string' || !dict[key])
    assert.deepEqual(missing, [], `${id}.json has no entry for these`)
  }
})

test('every dictionary carries the same keys, so a table-driven one cannot be half-translated', () => {
  const [first, ...rest] = TRANSLATED
  const reference = Object.keys(dictionary(first)).sort()
  for (const id of rest) {
    assert.deepEqual(Object.keys(dictionary(id)).sort(), reference, `${id}.json disagrees`)
  }
})

test('a translation keeps the placeholders its English original declares', () => {
  for (const id of TRANSLATED) {
    const dict = dictionary(id)
    for (const [key, value] of Object.entries(dict)) {
      if (key.startsWith('_')) continue
      assert.deepEqual(placeholders(value), placeholders(key), `${id}.json: ${key}`)
    }
  }
})

test('a key with no entry renders as the English it already is', () => {
  setLanguage('zh-TW')
  assert.equal(t('No such key exists in any dictionary'), 'No such key exists in any dictionary')
  assert.equal(t('Off duty'), dictionary('zh-TW')['Off duty'])
  setLanguage('en')
  assert.equal(t('Off duty'), 'Off duty')
})

test('placeholders are filled on the fallback too, not only on a hit', () => {
  setLanguage('en')
  assert.equal(t('Lv {level}', { level: 7 }), 'Lv 7')
  assert.equal(interpolate('{a} and {b}', { a: 1, b: 2 }), '1 and 2')
  // An unknown placeholder stays visible rather than becoming "undefined".
  assert.equal(interpolate('{a} and {b}', { a: 1 }), '1 and {b}')
})

test('an unknown language falls back to English rather than an empty UI', () => {
  assert.equal(setLanguage('klingon'), 'en')
  assert.equal(t('Off duty'), 'Off duty')
  assert.deepEqual(dictionary('klingon'), {})
})

test('the OS locale picks a language only when it is one we ship', () => {
  assert.equal(resolveLocale('zh-TW'), 'zh-TW')
  assert.equal(resolveLocale('zh-Hant-TW'), 'zh-TW')
  assert.equal(resolveLocale('zh_HK'), 'zh-TW')
  assert.equal(resolveLocale('ko'), 'ko')
  assert.equal(resolveLocale('ko-KR'), 'ko')
  // Simplified Chinese is not Traditional; English is the honest answer.
  assert.equal(resolveLocale('zh-CN'), 'en')
  assert.equal(resolveLocale('zh-Hans-SG'), 'en')
  assert.equal(resolveLocale('en-US'), 'en')
  assert.equal(resolveLocale(''), 'en')
  assert.equal(resolveLocale(undefined), 'en')
})
