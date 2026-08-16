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

test('Automatic play runs the LLM agent until a worker is picked', () => {
  assert.equal(settingsStore.usesWorker(settings()), false)
  assert.equal(settingsStore.usesWorker(settings({ workerKind: 'none' })), false)
  for (const kind of ['fighter', 'fisher']) {
    assert.equal(settingsStore.usesWorker(settings({ workerKind: kind })), true, kind)
  }
})

test('a worker starts without a model or a base URL — there is no LLM to set up', () => {
  const missing = { llm: 'openai', models: { ...DEFAULTS.models, openai: '' }, openaiBaseUrl: '' }

  assert.notDeepEqual(settingsStore.validate(settings(missing)), [])
  assert.deepEqual(settingsStore.validate(settings({ ...missing, workerKind: 'fighter' })), [])
})

test('an unknown worker is refused before the agent is started', () => {
  const errors = settingsStore.validate(settings({ workerKind: 'lumberjack' }))

  assert.ok(
    errors.some((e) => e.includes('lumberjack')),
    `expected a complaint about the worker, got ${JSON.stringify(errors)}`,
  )
})
