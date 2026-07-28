'use strict'

/// Subset of TOML wide enough for agent-client's config: tables, arrays of
/// tables, and scalar values. Used only to import an existing config.toml —
/// the app writes config back from a template, not from this AST.

function stripComment(line) {
  let inString = false
  let quote = ''
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inString) {
      if (c === '\\') i++
      else if (c === quote) inString = false
    } else if (c === '"' || c === "'") {
      inString = true
      quote = c
    } else if (c === '#') {
      return line.slice(0, i)
    }
  }
  return line
}

function parseValue(raw) {
  if (raw.startsWith('"')) {
    return raw
      .slice(1, raw.lastIndexOf('"'))
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
  }
  if (raw.startsWith("'")) return raw.slice(1, raw.lastIndexOf("'"))
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (/^[+-]?\d+$/.test(raw)) return parseInt(raw, 10)
  if (/^[+-]?\d*\.\d+$/.test(raw)) return parseFloat(raw)
  return raw
}

function descend(root, path, makeLast) {
  const keys = path.split('.').map((k) => k.trim().replace(/^"|"$/g, ''))
  let node = root
  for (let i = 0; i < keys.length - 1; i++) {
    const next = node[keys[i]]
    if (Array.isArray(next)) node = next[next.length - 1]
    else node = node[keys[i]] || (node[keys[i]] = {})
  }
  return makeLast(node, keys[keys.length - 1])
}

function parseToml(text) {
  const root = {}
  let cur = root
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim()
    if (!line) continue

    let m = line.match(/^\[\[(.+?)\]\]$/)
    if (m) {
      cur = descend(root, m[1], (node, key) => {
        const arr = node[key] || (node[key] = [])
        const entry = {}
        arr.push(entry)
        return entry
      })
      continue
    }

    m = line.match(/^\[(.+?)\]$/)
    if (m) {
      cur = descend(root, m[1], (node, key) => node[key] || (node[key] = {}))
      continue
    }

    m = line.match(/^([A-Za-z0-9_."'-]+)\s*=\s*(.+)$/)
    if (m) cur[m[1].replace(/^"|"$/g, '')] = parseValue(m[2].trim())
  }
  return root
}

/// Escape a JS string for a TOML basic string.
function tomlString(value) {
  return `"${String(value == null ? '' : value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')}"`
}

module.exports = { parseToml, tomlString }
