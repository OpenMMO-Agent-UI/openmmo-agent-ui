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

// The ported XP curve, checked against the thresholds shared/src/skills.rs
// asserts for itself (0, 100, 500, 1400): a level starts at 0% and the next
// one's threshold is 100%, so a wrong curve shows up as a bar that fills at
// the wrong pace rather than as an error.
test('skill progress runs from the level threshold to the next one', async () => {
  const { skillProgressPct } = await bagWornPromise
  assert.equal(skillProgressPct({ level: 1, xp: 100 }), 0)
  assert.equal(skillProgressPct({ level: 1, xp: 300 }), 50)
  assert.equal(skillProgressPct({ level: 2, xp: 500 }), 0)
  assert.equal(skillProgressPct({ level: 2, xp: 1400 }), 100)
})

test('an untrained skill sits at the start of level 0', async () => {
  const { skillProgressPct } = await bagWornPromise
  assert.equal(skillProgressPct({ level: 0, xp: 0 }), 0)
})

// At the cap there is no next threshold to divide by, so the bar has to be
// told it is full rather than computing it.
test('a capped skill reads as full', async () => {
  const { skillProgressPct } = await bagWornPromise
  assert.equal(skillProgressPct({ level: 30, xp: 964500 }), 100)
})
