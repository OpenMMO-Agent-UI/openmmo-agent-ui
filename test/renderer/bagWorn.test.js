'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

// bagWorn.js reads `window.agentApp` at module load time (the renderer's
// system boundary, exposed by preload.js in the real app) — stub it before
// import so the pure itemLabel formatter can be exercised outside a browser.
global.window = global.window || { agentApp: {} }

const bagWornPromise = import('../../src/renderer/bagWorn.js')

test('itemLabel turns a snake_case id into title case', async () => {
  const { itemLabel } = await bagWornPromise
  assert.equal(itemLabel('healing_potion'), 'Healing Potion')
})

test('itemLabel prefixes the enchant level the way the game names gear', async () => {
  const { itemLabel } = await bagWornPromise
  assert.equal(itemLabel('iron_sword', 2), '+2 Iron Sword')
})

test('itemLabel omits the prefix when there is no enchant', async () => {
  const { itemLabel } = await bagWornPromise
  assert.equal(itemLabel('iron_sword', 0), 'Iron Sword')
  assert.equal(itemLabel('iron_sword', undefined), 'Iron Sword')
})

// The skill sheet mirrors the web client's abilities.ts and the server's
// abilities.rs: a class skill is had by class, Auscultation by anyone, Fishing
// only once learned — and each says whether the gear it takes is on.
test('a knight has Guardian Ward, and it is ready with a blade and a shield', async () => {
  const { availableSkills } = await bagWornPromise
  const bare = availableSkills('knight', [], {})
  assert.deepEqual(
    bare.map((s) => [s.id, s.ready, s.fire]),
    [
      ['guardian_ward', false, true],
      ['auscultation', false, false],
    ],
  )
  const armed = availableSkills('knight', [], {
    main_hand: { itemDefId: 'steel_longsword' },
    off_hand: { itemDefId: 'wooden_shield' },
  })
  assert.equal(armed[0].ready, true)
  // A great sword is two-handed: no shield, no ward.
  assert.equal(
    availableSkills('knight', [], { main_hand: { itemDefId: 'great_sword' } })[0].ready,
    false,
  )
})

test('a rogue has Double Slash instead, and it takes a dagger', async () => {
  const { availableSkills } = await bagWornPromise
  const rows = availableSkills('rogue', [], { main_hand: { itemDefId: 'dagger' } })
  assert.deepEqual(
    rows.map((s) => [s.id, s.source, s.ready]),
    [
      ['dagger_double_slash', 'rogue', true],
      ['auscultation', null, false],
    ],
  )
})

test('fishing appears only once learned, whatever the class', async () => {
  const { availableSkills } = await bagWornPromise
  assert.ok(!availableSkills('barbarian', [], {}).some((s) => s.id === 'fishing'))
  const learned = availableSkills('barbarian', ['fishing'], { main_hand: { itemDefId: 'fishing_rod' } })
  assert.deepEqual(
    learned.filter((s) => s.id === 'fishing').map((s) => [s.source, s.ready]),
    [['learned', true]],
  )
})

test('without a known class only learned skills are listed, so no session reads as no skills', async () => {
  const { availableSkills } = await bagWornPromise
  assert.deepEqual(availableSkills(null, [], {}), [])
  assert.deepEqual(
    availableSkills(null, ['fishing'], {}).map((s) => s.id),
    ['fishing'],
  )
})

// Item weights are tenths of a kilo, the same reading the game's own
// inventory panel shows (client InventoryPanel.svelte divides by 10).
test('bagWeightText reads carried against the cap in kilos', async () => {
  const { bagWeightText } = await bagWornPromise
  assert.equal(bagWeightText({ carried: 1234, capacity: 1500 }), '123.4 / 150.0 kg')
})

test('bagWeightText has nothing to say without a capacity', async () => {
  const { bagWeightText } = await bagWornPromise
  assert.equal(bagWeightText(null), null)
  assert.equal(bagWeightText({ carried: 10, capacity: 0 }), null)
})

// Mirrors agent-client's shop_info::format_price: 1g = 100s = 10,000c, with
// zero denominations omitted — and copper kept when the whole amount is zero,
// so an empty purse reads "0c" rather than blank.
test('gold reads in the denominations the game uses', async () => {
  const { formatGold } = await bagWornPromise
  assert.equal(formatGold(12345678), '1234g 56s 78c')
  assert.equal(formatGold(10000), '1g')
  assert.equal(formatGold(0), '0c')
  assert.equal(formatGold(-250), '-2s 50c')
})

test('bagRows groups instances and marks a row locked when any of them is', async () => {
  const { bagRows } = await bagWornPromise
  const rows = bagRows([
    { item_def_id: 'iron_sword', quantity: 1 },
    { item_def_id: 'iron_sword', quantity: 1, locked: true },
    { item_def_id: 'healing_potion', quantity: 3 },
  ])
  assert.deepEqual(
    rows.map(({ id, quantity, locked }) => ({ id, quantity, locked })),
    [
      { id: 'healing_potion', quantity: 3, locked: false },
      { id: 'iron_sword', quantity: 2, locked: true },
    ],
  )
})
