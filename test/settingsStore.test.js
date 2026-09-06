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

test('Automatic play still defaults to the fighter and refuses retired worker kinds', () => {
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

test('a template worker is supported and needs no LLM configuration', () => {
  const missing = {
    workerKind: 'template',
    llm: 'openai',
    models: { ...DEFAULTS.models, openai: '' },
    openaiBaseUrl: '',
  }

  assert.equal(settingsStore.usesWorker(settings(missing)), true)
  assert.deepEqual(settingsStore.validate(settings(missing)), [])
  assert.ok(settingsStore.WORKERS.includes('template'))
})

test('an unknown worker is refused before the agent is started', () => {
  const errors = settingsStore.validate(settings({ workerKind: 'lumberjack' }))

  assert.ok(
    errors.some((e) => e.includes('lumberjack')),
    `expected a complaint about the worker, got ${JSON.stringify(errors)}`,
  )
})
