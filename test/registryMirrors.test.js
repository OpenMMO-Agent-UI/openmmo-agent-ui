'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

/// The panel hardcodes two copies of registries that live in the game
/// checkout, because `src/renderer/` is a file:// page with no access to it:
/// `DUNGEONS` (the dungeoneer's picker) and `TITLE_NAMES` (the title picker).
/// Nothing tied either copy to its source, so upstream adding a row left the
/// panel quietly one row short.
///
/// Both had drifted by the time this test was written. Upstream shipped the
/// Sundered Bastion — 25 floors, chest tier 5, Barkan at the bottom — and the
/// picker still stopped at the 20-floor Skeleton Crypt, so the one dungeon the
/// conqueror could not be pointed at was the new one. `TITLE_NAMES` was
/// missing four rows, Barkan's two and Terraclash's two, and that one fails
/// softly: an unlisted title falls back to reading its id as words, so
/// `barkan_slayer` renders as plausible-looking English and nobody notices.
///
/// Soft fallbacks are why both drifted unnoticed. This is the hard one.
///
/// Read from `data-src/*.csv` rather than `data/*.json`: upstream generates
/// the JSON (client's `generate:csv`, tools/convert.mjs) and stopped tracking
/// it, so a checkout that has never run the generator has a stale JSON or none
/// at all. The CSV is the committed source of truth.

const ROOT = path.join(__dirname, '..')
const DATA_SRC = path.join(ROOT, 'deps', 'OpenMMO', 'data-src')
const APP_JS = path.join(ROOT, 'src', 'renderer', 'app.js')

/// These CSVs have no quoted fields — `chestDrops` separates with `;` exactly
/// so a plain split stays valid. Assert that rather than assume it, because a
/// quoted comma would silently shift every column after it.
function readCsv(file) {
  const text = fs.readFileSync(path.join(DATA_SRC, file), 'utf8').trim()
  assert.ok(!text.includes('"'), `${file} has quoted fields — this parser would misread them`)
  const [head, ...rows] = text.split('\n')
  const cols = head.split(',')
  return rows.filter(Boolean).map((row) => {
    const cells = row.split(',')
    return Object.fromEntries(cols.map((c, i) => [c, cells[i] ?? '']))
  })
}

/// The literals as the renderer declares them, parsed from source the way
/// i18n.test.js reads its keys — importing app.js would need a DOM and a
/// preload bridge, and the declaration order is part of what we are checking.
function appSource() {
  return fs.readFileSync(APP_JS, 'utf8')
}

/// The literal's own text, delimiter-matched rather than guessed. An earlier
/// version picked `{` or `[` by whether the name contained "TITLE", which
/// happened to work for the two tables that existed and silently returned
/// nothing for RESTOCK_ITEMS — an object whose values are arrays.
function literalBlock(source, name) {
  const start = source.indexOf(`const ${name} = `)
  assert.notEqual(start, -1, `${name} not found in app.js`)
  const open = start + `const ${name} = `.length
  const pairs = { '{': '}', '[': ']' }
  const close = pairs[source[open]]
  assert.ok(close, `${name} is not an object or array literal`)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === source[open]) depth++
    else if (source[i] === close && --depth === 0) return source.slice(open, i + 1)
  }
  assert.fail(`${name}'s literal is unterminated`)
}

test('the dungeon picker lists every dungeon the game ships', (t) => {
  if (!fs.existsSync(DATA_SRC)) {
    t.skip('deps/OpenMMO not checked out')
    return
  }
  const expected = readCsv('dungeons.csv').map((d) => ({
    id: d.id,
    name: d.name,
    floors: Number(d.floors),
  }))
  assert.ok(expected.length >= 4, `parsed only ${expected.length} dungeons — the parser is wrong`)

  const block = literalBlock(appSource(), 'DUNGEONS')
  const actual = [...block.matchAll(/\{\s*id:\s*'([^']+)',\s*name:\s*'([^']+)',\s*floors:\s*(\d+)\s*\}/g)].map(
    (m) => ({ id: m[1], name: m[2], floors: Number(m[3]) })
  )

  // Ascending difficulty is the stated order of the list and the order the
  // picker shows, so compare the sequence, not just the membership.
  assert.deepEqual(
    actual,
    expected,
    'src/renderer/app.js DUNGEONS no longer mirrors deps/OpenMMO/data-src/dungeons.csv'
  )
})

test('the title picker names every title the game awards', (t) => {
  if (!fs.existsSync(DATA_SRC)) {
    t.skip('deps/OpenMMO not checked out')
    return
  }
  const rows = readCsv('titles.csv')
  assert.ok(rows.length >= 9, `parsed only ${rows.length} titles — the parser is wrong`)
  const expected = rows
    .slice()
    .sort((a, b) => Number(a.order) - Number(b.order))
    .map((r) => [r.id, r.name])

  const block = literalBlock(appSource(), 'TITLE_NAMES')
  const actual = [...block.matchAll(/^\s{2}([a-z0-9_]+):\s*'((?:[^'\\]|\\.)*)',/gm)].map((m) => [
    m[1],
    m[2].replace(/\\'/g, "'"),
  ])

  assert.deepEqual(
    actual,
    expected,
    'src/renderer/app.js TITLE_NAMES no longer mirrors deps/OpenMMO/data-src/titles.csv'
  )
})

/// `RESTOCK_ITEMS` is the third hardcoded mirror in app.js: what a worker's
/// town trip may be told to buy, by category. It was not covered when the
/// other two were, and it had already drifted — `supreme_healing_potion` and
/// the four rice dishes were in the game and not in the picker, so the
/// dungeoneer could not be pointed at the strongest potion that exists. The
/// failure is quiet in the same way the title table's was: the list is simply
/// short, nothing errors, and a player has to notice.
const RESTOCK_CATEGORIES = {
  workerFoodItem: 'food',
  workerPotionItem: 'healing_potion',
  workerScrollItem: 'return_scroll',
}

test('the worker restock pickers list every item of their category', (t) => {
  if (!fs.existsSync(DATA_SRC)) {
    t.skip('deps/OpenMMO not checked out')
    return
  }
  const items = readCsv('items.csv')
  assert.ok(items.length > 50, `parsed only ${items.length} items — the parser is wrong`)

  const block = literalBlock(appSource(), 'RESTOCK_ITEMS')
  for (const [key, category] of Object.entries(RESTOCK_CATEGORIES)) {
    const expected = items.filter((i) => i.category === category).map((i) => i.id)
    assert.ok(expected.length, `no items of category ${category} — check the category name`)

    // The list for this key, in declaration order: `key: [...]` either on one
    // line or spread over several.
    const at = block.indexOf(`${key}:`)
    assert.notEqual(at, -1, `${key} not found in RESTOCK_ITEMS`)
    const list = block.slice(block.indexOf('[', at), block.indexOf(']', at))
    const actual = [...list.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1])

    // Order matters: app.js documents the first entry as the "Auto" fallback,
    // so compare the sequence against the CSV's own order, not just the set.
    assert.deepEqual(
      actual,
      expected,
      `app.js RESTOCK_ITEMS.${key} no longer mirrors category "${category}" in ` +
        `deps/OpenMMO/data-src/items.csv`
    )
  }
})
