'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const settingsPanelPromise = import('../../src/renderer/settingsPanel.js')

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
