'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const { PlaySessionCoordinator } = require('../src/playSession')

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function fixture({ llmValid = true } = {}) {
  const events = []
  const scheduled = []
  const ai = {
    start: async () => {
      events.push('ai:start')
      return { viewUrl: 'http://ai-view' }
    },
    stop: async () => events.push('ai:stop'),
    cancelPending: async () => events.push('ai:cancel'),
  }
  const manual = {
    start: async () => {
      events.push('manual:start')
      return { viewUrl: 'http://manual-view' }
    },
    stop: async () => events.push('manual:stop'),
  }
  const scheduler = {
    schedule(fn, delayMs) {
      const item = { fn, delayMs, canceled: false }
      scheduled.push(item)
      return () => {
        item.canceled = true
      }
    },
  }
  const coordinator = new PlaySessionCoordinator({
    ai,
    manual,
    validateLlm: async () => ({ ok: llmValid, error: llmValid ? null : 'Set up an LLM' }),
    scheduler,
  })
  return { ai, manual, coordinator, events, scheduled }
}

test('entering a character starts Automatic play by default', async () => {
  const { coordinator, events } = fixture()

  const state = await coordinator.enter({ characterId: 7 })

  assert.equal(state.mode, 'ai')
  assert.equal(state.phase, 'active')
  assert.equal(state.viewUrl, 'http://ai-view')
  assert.deepEqual(events, ['ai:start'])
})

test('an invalid global LLM configuration falls back to manual play', async () => {
  const { coordinator, events } = fixture({ llmValid: false })

  const state = await coordinator.enter({ characterId: 7 })

  assert.equal(state.mode, 'manual')
  assert.equal(state.phase, 'active')
  assert.equal(state.notice, 'Set up an LLM')
  assert.deepEqual(events, ['manual:start'])
})

test('AI to manual handoff cancels pending work before changing controller', async () => {
  const { coordinator, events } = fixture()
  await coordinator.enter({ characterId: 7 })

  const state = await coordinator.switchTo('manual')

  assert.equal(state.mode, 'manual')
  assert.equal(state.phase, 'active')
  assert.deepEqual(events, ['ai:start', 'ai:cancel', 'ai:stop', 'manual:start'])
})

test('failed handoff restores the prior working controller', async () => {
  const { coordinator, events, manual } = fixture()
  await coordinator.enter({ characterId: 7 })
  manual.start = async () => {
    events.push('manual:start')
    throw new Error('manual failed')
  }

  const state = await coordinator.switchTo('manual')

  assert.equal(state.mode, 'ai')
  assert.equal(state.phase, 'active')
  assert.equal(state.notice, 'manual failed')
  assert.deepEqual(events, [
    'ai:start',
    'ai:cancel',
    'ai:stop',
    'manual:start',
    'manual:stop',
    'ai:start',
  ])
})

test('failed initial AI readiness is cleaned up before manual fallback', async () => {
  const { coordinator, events, ai } = fixture()
  ai.start = async () => {
    events.push('ai:start')
    throw new Error('world readiness timed out')
  }

  const state = await coordinator.enter({ characterId: 7 })

  assert.equal(state.mode, 'manual')
  assert.deepEqual(events, ['ai:start', 'ai:cancel', 'ai:stop', 'manual:start'])
})

test('cleanup failure disconnects instead of starting a second controller', async () => {
  const { coordinator, events, ai } = fixture()
  ai.start = async () => {
    events.push('ai:start')
    throw new Error('world readiness timed out')
  }
  ai.stop = async () => {
    events.push('ai:stop')
    throw new Error('AI would not stop')
  }

  const state = await coordinator.enter({ characterId: 7 })

  assert.equal(state.phase, 'disconnected')
  assert.equal(state.mode, null)
  assert.match(state.notice, /could not stop Automatic play/)
  assert.equal(events.includes('manual:start'), false)
})

test('failed target cleanup disconnects instead of restoring the prior controller', async () => {
  const { coordinator, events, manual } = fixture()
  await coordinator.enter({ characterId: 7 })
  manual.start = async () => {
    events.push('manual:start')
    throw new Error('manual failed')
  }
  manual.stop = async () => {
    events.push('manual:stop')
    throw new Error('manual would not stop')
  }

  const state = await coordinator.switchTo('manual')

  assert.equal(state.phase, 'disconnected')
  assert.equal(state.mode, null)
  assert.match(state.notice, /could not stop manual/)
  assert.equal(events.filter((event) => event === 'ai:start').length, 1)
})

test('unexpected AI exit retries forever with a delay capped at 30 seconds', async () => {
  const { coordinator, events, scheduled } = fixture()
  await coordinator.enter({ characterId: 7 })

  for (const expected of [2000, 5000, 10000, 30000, 30000]) {
    coordinator.controllerExited('AI disconnected')
    assert.equal(coordinator.snapshot().phase, 'retrying')
    assert.equal(scheduled.at(-1).delayMs, expected)
    await scheduled.at(-1).fn()
    assert.equal(coordinator.snapshot().phase, 'active')
  }

  assert.equal(events.filter((event) => event === 'ai:start').length, 6)
})

test('switching to manual cancels an automatic retry timer', async () => {
  const { coordinator, scheduled } = fixture()
  await coordinator.enter({ characterId: 7 })
  coordinator.controllerExited('AI disconnected')

  const state = await coordinator.switchTo('manual')

  assert.equal(scheduled[0].canceled, true)
  assert.equal(state.mode, 'manual')
  assert.equal(state.phase, 'active')
})

test('switching waits for an in-flight retry to clean up before starting manual play', async () => {
  const { coordinator, scheduled, ai, events } = fixture()
  await coordinator.enter({ characterId: 7 })
  coordinator.controllerExited('AI disconnected')
  const lateStart = deferred()
  ai.start = () => {
    events.push('ai:retry-start')
    return lateStart.promise
  }

  const retrying = scheduled[0].fn()
  while (!events.includes('ai:retry-start')) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  const switching = coordinator.switchTo('manual')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(events.includes('manual:start'), false)

  lateStart.resolve({ viewUrl: 'http://late-ai-view' })
  await retrying
  const state = await switching

  assert.equal(state.mode, 'manual')
  assert.equal(state.phase, 'active')
  assert.ok(events.lastIndexOf('ai:stop') < events.indexOf('manual:start'))
})

test('target mode is not committed until its controller is ready', async () => {
  const { coordinator, manual } = fixture()
  await coordinator.enter({ characterId: 7 })
  const ready = deferred()
  manual.start = () => ready.promise

  const switching = coordinator.switchTo('manual')
  assert.equal(coordinator.snapshot().phase, 'switching')
  assert.equal(coordinator.snapshot().mode, 'ai')

  ready.resolve({ viewUrl: 'http://manual-view' })
  const state = await switching
  assert.equal(state.mode, 'manual')
  assert.equal(state.phase, 'active')
})
