'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const actionToastsPromise = import('../../src/renderer/actionToasts.js')

test('actionLabel formats a move toward a named target', async () => {
  const { actionLabel } = await actionToastsPromise
  assert.equal(actionLabel({ type: 'move', target: 'Aldermark' }, new Map()), 'Move→Aldermark')
})

test('actionLabel formats a move by coordinates when there is no target', async () => {
  const { actionLabel } = await actionToastsPromise
  assert.equal(actionLabel({ type: 'move', x: 12.6, z: -3.2 }, new Map()), 'Move→(13, -3)')
})

test('actionLabel resolves an attack target through the monster name lookup', async () => {
  const { actionLabel } = await actionToastsPromise
  const monsterNames = new Map([['m1045_5', 'kobold']])
  assert.equal(actionLabel({ type: 'attack', monster_id: 'm1045_5' }, monsterNames), 'Attack→kobold')
})

test('actionLabel falls back to the raw id when a monster is unknown', async () => {
  const { actionLabel } = await actionToastsPromise
  assert.equal(actionLabel({ type: 'attack', monster_id: 'm999' }, new Map()), 'Attack→m999')
})

test('actionLabel truncates a long say message', async () => {
  const { actionLabel } = await actionToastsPromise
  const label = actionLabel({ type: 'say', message: 'a'.repeat(40) }, new Map())
  assert.equal(label, `Say "${'a'.repeat(24)}…"`)
})

test('actionLabel returns empty for a missing or malformed action', async () => {
  const { actionLabel } = await actionToastsPromise
  assert.equal(actionLabel(null, new Map()), '')
  assert.equal(actionLabel(undefined, new Map()), '')
  assert.equal(actionLabel('not-an-object', new Map()), '')
})

test('actionLabel falls back to the raw type for an unrecognized action', async () => {
  const { actionLabel } = await actionToastsPromise
  assert.equal(actionLabel({ type: 'some_future_action' }, new Map()), 'some_future_action')
})
