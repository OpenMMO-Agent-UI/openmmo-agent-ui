'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const { characterFromWire } = require('../src/characterSession')

test('characterFromWire reads the positional Character layout including deletion_due_at', () => {
  const attributes = [10, 10, 10, 10, 10, 10]
  const wire = [7, null, 'Hero7', 1700000000, 12, 3400, 150, attributes, 'Knight', 'Female', [], [], null]

  assert.deepEqual(characterFromWire(wire), {
    id: 7,
    deletionDueAt: null,
    name: 'Hero7',
    createdAt: 1700000000,
    level: 12,
    xp: 3400,
    maxHp: 150,
    attributes,
    class: 'Knight',
    gender: 'Female',
  })
})
