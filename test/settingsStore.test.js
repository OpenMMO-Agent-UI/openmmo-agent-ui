'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const settingsStore = require('../src/settingsStore')
const { DEFAULTS } = settingsStore

function settings(overrides = {}) {
  return {
    ...DEFAULTS,
    server: 'wss://openmmo.to.nexus/ws',
    characterName: 'Ryulamg',
    ...overrides,
  }
}

test('Automatic play runs the fighter, the only driver there is for now', () => {
  assert.equal(DEFAULTS.workerKind, 'fighter')
  assert.equal(settingsStore.usesWorker(settings()), true)
  // The LLM agent is off: nothing can select it, and a stored `none` from an
  // older build is refused rather than quietly starting a driver with no panel.
  assert.equal(settingsStore.usesWorker(settings({ workerKind: 'none' })), false)
  assert.notDeepEqual(settingsStore.validate(settings({ workerKind: 'none' })), [])
})

test('the fighter starts without a model or a base URL — there is no LLM to set up', () => {
  const missing = { llm: 'openai', models: { ...DEFAULTS.models, openai: '' }, openaiBaseUrl: '' }

  assert.deepEqual(settingsStore.validate(settings(missing)), [])
})

test('an unknown worker is refused before the agent is started', () => {
  const errors = settingsStore.validate(settings({ workerKind: 'lumberjack' }))

  assert.ok(
    errors.some((e) => e.includes('lumberjack')),
    `expected a complaint about the worker, got ${JSON.stringify(errors)}`,
  )
})
