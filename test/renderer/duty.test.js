'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const dutyPromise = import('../../src/renderer/duty.js')

// The header's state word had two writers with two vocabularies: the agent
// process wrote "running (pid 4213)"/"stopped", the play session wrote its raw
// phase. These assert the single reading they collapsed into.
test('a stopped agent is off duty whatever the last session phase was', async () => {
  const { dutyState } = await dutyPromise
  assert.deepEqual(dutyState(false, 'active', 0), { label: 'Off duty', tone: 'off' })
})

test('a running agent with no interesting phase is simply on duty', async () => {
  const { dutyState } = await dutyPromise
  assert.deepEqual(dutyState(true, 'active', 0), { label: 'On duty', tone: 'live' })
  // playSession publishes `stopped` as its initial phase; the process being up
  // is what decides, so an unmapped phase must not read as an error.
  assert.deepEqual(dutyState(true, 'stopped', 0), { label: 'On duty', tone: 'live' })
})

test('a retry counts down in whole seconds and reads as needing attention', async () => {
  const { dutyState } = await dutyPromise
  assert.deepEqual(dutyState(true, 'retrying', 3400), { label: 'Retrying in 4s', tone: 'bad' })
  // Past the deadline, and a clock that jumped: neither may print "in -1s".
  assert.deepEqual(dutyState(true, 'retrying', -500), { label: 'Retrying', tone: 'bad' })
})

// The curve doubles each level (shared/src/xp.rs): Lv3 starts at 40, Lv4 at 80.
test('the level bar reads how far into the current level the character is', async () => {
  const { xpProgressPct } = await dutyPromise
  assert.equal(xpProgressPct({ level: 3, xp: 40 }), 0)
  assert.equal(xpProgressPct({ level: 3, xp: 60 }), 50)
  assert.equal(xpProgressPct({ level: 1, xp: 10 }), 50)
  // A total that has outrun its level (the gain frame arrives before the
  // level-up) must not print a bar wider than its track.
  assert.equal(xpProgressPct({ level: 3, xp: 200 }), 100)
})

test('a dropped connection is named, not left as a phase id', async () => {
  const { dutyState } = await dutyPromise
  assert.deepEqual(dutyState(true, 'disconnected', 0), { label: 'Disconnected', tone: 'bad' })
  assert.deepEqual(dutyState(true, 'switching', 0), { label: 'Switching', tone: 'live' })
})

// The bands the server judges (shared/src/hunger.rs): Normal at 300+, Hungry
// at 100+, Weak below. The header says what the character can still do,
// because that is what a person acts on.
test('a fed character reads by the fraction, in brass', async () => {
  const { hungerReading } = await dutyPromise
  assert.deepEqual(hungerReading({ satiation: 700, band: 'Normal', max: 1000 }), {
    pct: 70,
    text: '700/1000',
    label: 'Fed',
    tone: 'ok',
  })
})

test('the two bands worth acting on name the cost, not the band', async () => {
  const { hungerReading } = await dutyPromise
  assert.equal(hungerReading({ satiation: 200, band: 'Hungry', max: 1000 }).label, 'Hungry · no sprint')
  assert.equal(hungerReading({ satiation: 50, band: 'Weak', max: 1000 }).tone, 'bad')
})

// Official NPCs are exempt from hunger, so no reading ever arrives for them.
test('no satiation reading means no bar at all', async () => {
  const { hungerReading } = await dutyPromise
  assert.equal(hungerReading(null), null)
  assert.equal(hungerReading({ band: 'Normal' }), null)
})

test('attributes read in the order the game rolls them, guard excluded', async () => {
  const { attributeCells } = await dutyPromise
  const cells = attributeCells({ str: 14, dex: 12, con: 13, int: 10, wis: 11, cha: 9, guard: 12 })
  assert.deepEqual(
    cells.map((c) => c.label),
    ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA']
  )
  assert.equal(cells[0].value, 14)
  assert.deepEqual(attributeCells(null), [])
})
