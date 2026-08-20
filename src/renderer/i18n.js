'use strict'

/// The renderer's half of src/i18n.js. That module is CommonJS in the main
/// process and cannot be imported into this sandbox, so `t` is restated here
/// over a dictionary handed across IPC — the same split backends.js already
/// lives with (see app.js's agentEndpoint).

let dict = {}
let current = 'en'

export function setDictionary(next, id = 'en') {
  dict = next && typeof next === 'object' ? next : {}
  current = id
}

/// The BCP 47 tag for the language in force, for the Intl formatters that
/// take one (see signInFlow's agoLabel).
export function language() {
  return current
}

export function interpolate(text, params) {
  if (!params) return text
  return text.replace(/\{(\w+)\}/g, (whole, name) =>
    Object.hasOwn(params, name) ? String(params[name]) : whole,
  )
}

/// English original as key: a key with no entry renders the English it is.
export function t(key, params) {
  const entry = dict[key]
  return interpolate(typeof entry === 'string' && entry ? entry : key, params)
}

/// The English a marked node started with. Kept off the element (a `data-`
/// attribute would be overwritten on the second switch, which is how a
/// language switch ends up looking up Chinese text in a Chinese dictionary)
/// and captured once, on the first pass.
const originals = new WeakMap()

function originalOf(el) {
  let entry = originals.get(el)
  if (entry) return entry
  entry = {
    texts: textNodes(el).map((node) => node.nodeValue),
    attrs: Object.fromEntries(
      attrNames(el).map((name) => [name, el.getAttribute(name) ?? '']),
    ),
  }
  originals.set(el, entry)
  return entry
}

/// Direct child text nodes only: a marked `<label>` carries its own words and
/// an `<input>`, so writing `textContent` would delete the control.
function textNodes(el) {
  return [...el.childNodes].filter((node) => node.nodeType === 3 && node.nodeValue.trim())
}

function attrNames(el) {
  return (el.dataset.i18nAttr || '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
}

/// Rewrites every marked node in place. Safe to call again on every language
/// change, and on a subtree once one is built.
export function applyI18n(root = document) {
  const marked = [...root.querySelectorAll('[data-i18n], [data-i18n-attr]')]
  if (root.matches?.('[data-i18n], [data-i18n-attr]')) marked.unshift(root)
  for (const el of marked) {
    const original = originalOf(el)
    if (el.hasAttribute('data-i18n')) {
      const nodes = textNodes(el)
      for (const [index, node] of nodes.entries()) {
        const raw = original.texts[index] ?? node.nodeValue
        // Source markup wraps long sentences, so the key is the collapsed
        // text; the surrounding whitespace is layout and stays as it was.
        const key = raw.trim().replace(/\s+/g, ' ')
        node.nodeValue = `${raw.match(/^\s*/)[0]}${t(key)}${raw.match(/\s*$/)[0]}`
      }
    }
    for (const [name, value] of Object.entries(original.attrs)) {
      el.setAttribute(name, t(value))
    }
  }
}
