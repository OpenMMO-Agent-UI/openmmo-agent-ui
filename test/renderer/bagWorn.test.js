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
