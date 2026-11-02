'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { parseItemsCsv, catalogue, ITEM_LOCALES, NOT_CARRIED } = require('../src/itemCatalogue')

const CHECKOUT = path.join(__dirname, '..', 'deps', 'OpenMMO')
const DATA_SRC = path.join(CHECKOUT, 'data-src')
const GAME_LOCALES = path.join(CHECKOUT, 'client', 'src', 'lib', 'i18n', 'locales')

/// A throwaway root with exactly the files a packaged build stages, so these
/// tests exercise the real shape without needing a checkout.
function stage(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'items-'))
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), body)
  }
  return dir
}

const CSV = [
  'id,name,category,basePrice',
  'iron_sword,Iron Sword,weapon,10000',
  'oak_chair,Oak Chair,furniture,500',
  'healing_potion,Healing Potion,healing_potion,300',
].join('\n')

test('a quoted field is refused rather than silently misread', () => {
  assert.throws(
    () => parseItemsCsv('id,name\n1,"Sword, Iron"\n'),
    /quoted fields/,
    'a quoted comma shifts every later column — the parser must not guess'
  )
})

test('an empty or missing table reads as no catalogue, not a crash', () => {
  assert.deepEqual(parseItemsCsv(''), [])
  assert.deepEqual(parseItemsCsv(null), [])
  assert.deepEqual(catalogue([path.join(os.tmpdir(), 'no-such-dir')], 'en'), [])
})

/// The drawer falls back to listing the bag when the catalogue is empty,
/// which is all it could do before the catalogue existed — so an unreadable
/// table must degrade, never throw.
test('a malformed table degrades to an empty catalogue', () => {
  const dir = stage({ 'items.csv': 'id,name\n1,"quoted"\n' })
  assert.deepEqual(catalogue([dir], 'en'), [])
})

test('what nobody carries is left out of the list', () => {
  const dir = stage({ 'items.csv': CSV })
  const ids = catalogue([dir], 'en').map((i) => i.id)
  assert.ok(ids.includes('iron_sword'))
  assert.ok(ids.includes('healing_potion'))
  assert.ok(
    !ids.includes('oak_chair'),
    'furniture is placed on land, never carried in a bag a worker manages'
  )
  assert.ok(NOT_CARRIED.has('furniture'))
})

test('rows carry the id, name, category and price, name-sorted', () => {
  const dir = stage({ 'items.csv': CSV })
  assert.deepEqual(catalogue([dir], 'en'), [
    { id: 'healing_potion', name: 'Healing Potion', category: 'healing_potion', price: 300 },
    { id: 'iron_sword', name: 'Iron Sword', category: 'weapon', price: 10000 },
  ])
})

/// The game keys an item's localized name `<id>.name`. English needs no
/// dictionary — the CSV's own `name` column is the English name, which is
/// also what the game shows an English player.
test('a localized name wins over the English one, per key', () => {
  const dir = stage({
    'items.csv': CSV,
    'zh-Hant.items.json': JSON.stringify({ 'iron_sword.name': '鐵劍' }),
  })
  const byId = new Map(catalogue([dir], 'zh-TW').map((i) => [i.id, i.name]))
  assert.equal(byId.get('iron_sword'), '鐵劍')
  assert.equal(
    byId.get('healing_potion'),
    'Healing Potion',
    'a partial dictionary still translates what it covers'
  )
  assert.equal(
    catalogue([dir], 'en').find((i) => i.id === 'iron_sword').name,
    'Iron Sword',
    'English reads the table, not a dictionary'
  )
})

test('a corrupt name dictionary falls back to English instead of throwing', () => {
  const dir = stage({ 'items.csv': CSV, 'zh-Hant.items.json': '{ not json' })
  assert.equal(catalogue([dir], 'zh-TW').find((i) => i.id === 'iron_sword').name, 'Iron Sword')
})

test('the first root that has the file wins, so a bundle shadows a checkout', () => {
  const bundled = stage({ 'items.csv': 'id,name,category,basePrice\na,Bundled,weapon,1' })
  const checkout = stage({ 'items.csv': 'id,name,category,basePrice\na,Checkout,weapon,1' })
  assert.equal(catalogue([bundled, checkout], 'en')[0].name, 'Bundled')
  assert.equal(catalogue([checkout, bundled], 'en')[0].name, 'Checkout')
})

/// The two things the panel reads out of the game tree. Named here because
/// `scripts/package-resources.sh` stages them by exactly these paths and a
/// rename upstream would otherwise only show up as a silently empty list.
test('the files this reads still exist in the checkout', (t) => {
  if (!fs.existsSync(CHECKOUT)) {
    t.skip('deps/OpenMMO not checked out')
    return
  }
  assert.ok(
    fs.existsSync(path.join(DATA_SRC, 'items.csv')),
    'data-src/items.csv is the committed source of truth the generator reads'
  )
  for (const locale of Object.values(ITEM_LOCALES)) {
    assert.ok(
      fs.existsSync(path.join(GAME_LOCALES, `${locale}.items.json`)),
      `${locale}.items.json — a panel language mapped to a game dictionary that is gone`
    )
  }
})

/// The real table, parsed the way the app will parse it. Guards the
/// assumption the whole feature rests on: that the committed CSV is readable
/// without a generator step and holds the columns the rows are built from.
test('the shipped table parses into a usable catalogue', (t) => {
  if (!fs.existsSync(DATA_SRC)) {
    t.skip('deps/OpenMMO not checked out')
    return
  }
  const rows = catalogue([DATA_SRC, GAME_LOCALES], 'en')
  assert.ok(rows.length > 100, `only ${rows.length} items — the parse is wrong`)
  assert.ok(
    rows.every((r) => r.id && r.name),
    'every row needs an id and something to show the player'
  )
  const byId = new Map(rows.map((r) => [r.id, r]))
  // One of each kind the picker has to cover: priced gear, a consumable, and
  // the junk whose Drop mark started all this.
  assert.ok(byId.get('iron_sword')?.price > 0)
  assert.equal(byId.get('healing_potion')?.category, 'healing_potion')
  assert.ok(byId.has('old_boot'))
  assert.ok(
    !rows.some((r) => NOT_CARRIED.has(r.category)),
    'the excluded categories really are excluded'
  )

  // And the localized path against the real dictionary, not a stub.
  const zh = new Map(catalogue([DATA_SRC, GAME_LOCALES], 'zh-TW').map((r) => [r.id, r.name]))
  assert.notEqual(zh.get('healing_potion'), byId.get('healing_potion').name)
})
