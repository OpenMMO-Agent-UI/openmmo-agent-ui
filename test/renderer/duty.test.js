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

test('a dropped connection is named, not left as a phase id', async () => {
  const { dutyState } = await dutyPromise
  assert.deepEqual(dutyState(true, 'disconnected', 0), { label: 'Disconnected', tone: 'bad' })
  assert.deepEqual(dutyState(true, 'switching', 0), { label: 'Switching', tone: 'live' })
})

test('attributes read in the order the game rolls them, guard last', async () => {
  const { attributeCells } = await dutyPromise
  const cells = attributeCells({ str: 14, dex: 12, con: 13, int: 10, wis: 11, cha: 9, guard: 12 })
  assert.deepEqual(
    cells.map((c) => c.label),
    ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA', 'GUARD']
  )
  assert.equal(cells[0].value, 14)
  assert.deepEqual(attributeCells(null), [])
})

// A worn gold ring adds +1 CHA and a breastplate adds to guard, and the
// server reports the sums rather than letting a client redo the formula.
test('gear-fed attributes read at the value the server acts on, with the bonus named', async () => {
  const { attributeCells } = await dutyPromise
  const rolled = { str: 14, dex: 12, con: 13, int: 10, wis: 11, cha: 9, guard: 10 }
  const cells = attributeCells(rolled, { guard: 14, cha: 10 })
  const by = Object.fromEntries(cells.map((c) => [c.key, c]))
  assert.deepEqual(by.cha, { key: 'cha', label: 'CHA', value: 10, bonus: 1 })
  assert.deepEqual(by.guard, { key: 'guard', label: 'GUARD', value: 14, bonus: 4 })
  // Nothing else the gear does not move reports a bonus.
  assert.equal(by.str.value, 14)
  assert.equal(by.str.bonus, 0)
})

test('without a stats push the rolled attributes stand on their own', async () => {
  const { attributeCells } = await dutyPromise
  const cells = attributeCells({ str: 14, cha: 9, guard: 10 }, null)
  assert.deepEqual(
    cells.map((c) => [c.label, c.value, c.bonus]),
    [['STR', 14, 0], ['CHA', 9, 0], ['GUARD', 10, 0]]
  )
})

// Guard reaches us only once the character is in the world; a reading without
// it is six cells, not five and a blank.
test('an attribute the server has not sent yet takes no cell', async () => {
  const { attributeCells } = await dutyPromise
  const cells = attributeCells({ str: 14, dex: 12, con: 13, int: 10, wis: 11, cha: 9 })
  assert.deepEqual(
    cells.map((c) => c.label),
    ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA']
  )
})
