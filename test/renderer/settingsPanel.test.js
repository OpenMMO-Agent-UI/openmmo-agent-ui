'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const settingsPanelPromise = import('../../src/renderer/settingsPanel.js')

test('nearestCadenceIndex picks the option closest to the stored seconds value', async () => {
  const { nearestCadenceIndex } = await settingsPanelPromise
  const options = [
    ['Very fast', 3],
    ['Fast', 5],
    ['Balanced', 10],
  ]
  assert.equal(nearestCadenceIndex(options, 3), 0)
  assert.equal(nearestCadenceIndex(options, 4), 0)
  assert.equal(nearestCadenceIndex(options, 6), 1)
  assert.equal(nearestCadenceIndex(options, 9999), 2)
})

test('nearestCadenceIndex defaults to the first option for a single-entry list', async () => {
  const { nearestCadenceIndex } = await settingsPanelPromise
  assert.equal(nearestCadenceIndex([['Only', 42]], 1), 0)
})

test('humanInterval states an interval in the largest unit that divides it', async () => {
  const { humanInterval } = await settingsPanelPromise
  assert.equal(humanInterval(1), '1 second')
  assert.equal(humanInterval(10), '10 seconds')
  assert.equal(humanInterval(60), '1 minute')
  assert.equal(humanInterval(90), '1.5 minutes')
  assert.equal(humanInterval(900), '15 minutes')
  assert.equal(humanInterval(3600), '1 hour')
  assert.equal(humanInterval(7200), '2 hours')
})
