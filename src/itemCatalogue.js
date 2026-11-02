'use strict'

const fs = require('node:fs')
const path = require('node:path')

/// Every item the game ships, for the bag drawer's catalogue mode. The sell
/// and drop marks are per `item_def_id`, so a player should be able to mark
/// one without first happening to hold it — which is what listing only the
/// bag forced. A dungeoneer's whole point is deciding in advance what it may
/// bin, and the thing you want to pre-mark is exactly the thing you have not
/// picked up yet.
///
/// `data-src/items.csv`, not the generated `data/items.json`, for the same
/// reason test/registryMirrors.test.js reads the CSV: the JSON is produced by
/// the game client's `generate:csv` and is gitignored, so a fresh checkout
/// may have a stale copy or none. The CSV is committed and is what the
/// generator itself reads.

/// The CSV has no quoted fields — `chestDrops` separates with `;` exactly so
/// a plain split stays valid. Asserted rather than assumed, because a quoted
/// comma would silently shift every column after it and the panel would show
/// prices in the name column.
function parseItemsCsv(text) {
  const body = String(text || '').trim()
  if (!body) return []
  if (body.includes('"')) {
    throw new Error('items.csv has quoted fields — this parser would misread them')
  }
  const [head, ...rows] = body.split('\n')
  const cols = head.split(',')
  return rows.filter(Boolean).map((row) => {
    const cells = row.split(',')
    return Object.fromEntries(cols.map((c, i) => [c, cells[i] ?? '']))
  })
}

/// The panel's three languages against the game's own item-name dictionaries.
/// Only two of them exist game-side; `en` needs none, because the CSV's
/// `name` column *is* the English name. A language with no mapping falls
/// through to that same English, which is what the game shows it too.
const ITEM_LOCALES = { 'zh-TW': 'zh-Hant', ko: 'ko' }

/// Categories a worker can never meet in a bag it manages, so listing them
/// would be 40 rows of noise between the player and the sword they came to
/// mark. Land and furniture are placed, not carried about; the landscaping
/// palette is a map-editor brush.
const NOT_CARRIED = new Set(['furniture', 'landscaping_palette', 'land_deed', 'peddler_stall'])

/// Which roots to look under, nearest first. A packaged build has the staged
/// copies beside the agent binary; a dev checkout reads the submodule.
function sources(roots) {
  return roots.filter(Boolean).map((root) => ({
    csv: path.join(root, 'items.csv'),
    locales: root,
  }))
}

function readFirst(candidates) {
  for (const file of candidates) {
    try {
      return fs.readFileSync(file, 'utf8')
    } catch {
      // Next root. A missing file is the normal case for all but one of them.
    }
  }
  return null
}

/// `<id>.name` is how the game keys an item's localized name
/// (client/src/lib/i18n/locales/<locale>.items.json). A key the dictionary
/// has no entry for falls back to the CSV's English, per key rather than per
/// file — a partially translated dictionary should still translate what it
/// covers.
function localizedNames(roots, language) {
  const locale = ITEM_LOCALES[language]
  if (!locale) return {}
  const raw = readFirst(roots.filter(Boolean).map((r) => path.join(r, `${locale}.items.json`)))
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

/// `{ id, name, category, price }` per item, name-sorted in the language
/// asked for, with what nobody carries left out. Empty when no source can be
/// read: the drawer falls back to listing the bag, which is what it did
/// before this existed.
function catalogue(roots, language) {
  const raw = readFirst(sources(roots).map((s) => s.csv))
  if (!raw) return []
  let rows = []
  try {
    rows = parseItemsCsv(raw)
  } catch {
    return []
  }
  const names = localizedNames(roots, language)
  const items = rows
    .filter((row) => row.id && !NOT_CARRIED.has(row.category))
    .map((row) => ({
      id: row.id,
      name: names[`${row.id}.name`] || row.name || row.id,
      category: row.category || '',
      price: Number(row.basePrice) || 0,
    }))
  return items.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}

module.exports = { parseItemsCsv, catalogue, ITEM_LOCALES, NOT_CARRIED }
