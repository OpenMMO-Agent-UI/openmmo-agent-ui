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

const SAVED = [
  { name: 'Aldermark', x: -1471.4, y: 0.9, z: 4741.2 },
  { name: 'Orc Warrens', x: -1616, y: 1.05, z: 4918 },
]

test('an unset anchor shows as the spawn point, not as a spot at the origin', async () => {
  const { anchorChoices } = await settingsPanelPromise
  const { choices, selected } = anchorChoices({ workerAnchorX: null, workerAnchorZ: null }, SAVED)

  assert.equal(choices[0], null, 'index 0 is always "no anchor picked"')
  assert.equal(selected, 0)
  assert.equal(choices.length, SAVED.length + 1, 'nothing invented for an unset anchor')
})

test('the stored anchor is the option showing, matched on where it is', async () => {
  const { anchorChoices } = await settingsPanelPromise
  const { choices, selected } = anchorChoices(
    { workerAnchorName: 'Orc Warrens', workerAnchorX: -1616, workerAnchorZ: 4918 },
    SAVED,
  )

  assert.equal(choices[selected].name, 'Orc Warrens')
  assert.equal(choices.length, SAVED.length + 1, 'an anchor already in the list is not offered twice')
})

test('an anchor the saved list no longer holds is still offered and still picked', async () => {
  const { anchorChoices } = await settingsPanelPromise
  const gone = { workerAnchorName: 'Old Camp', workerAnchorX: 12, workerAnchorZ: -8 }
  const { choices, selected } = anchorChoices(gone, SAVED)

  assert.deepEqual(choices[selected], { name: 'Old Camp', x: 12, z: -8 })
  assert.equal(selected, choices.length - 1, 'appended rather than resetting to the spawn point')
})

test('an anchor imported from a config.toml has no name to show, and is still picked', async () => {
  const { anchorChoices } = await settingsPanelPromise
  const { choices, selected } = anchorChoices({ workerAnchorX: 12, workerAnchorZ: -8 }, SAVED)

  assert.equal(choices[selected].name, '', 'the panel labels a nameless anchor itself')
  assert.notEqual(selected, 0)
})
