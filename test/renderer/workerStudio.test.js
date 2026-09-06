'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const studioPromise = import('../../src/renderer/workerStudio.js')

test('conditionSummary makes nested worker conditions concise', async () => {
  const { conditionSummary } = await studioPromise
  const condition = {
    all: [
      { lt: [{ ref: 'self.health_pct' }, 30] },
      { exists: { ref: 'self.position' } },
    ],
  }

  assert.equal(conditionSummary(condition), 'self.health_pct < 30 AND exists self.position')
})

test('actionSummary describes actions and intents without markup', async () => {
  const { actionSummary } = await studioPromise
  const malicious = '<img src=x onerror=alert(1)>'

  assert.equal(actionSummary({ intent: 'patrol' }), 'Intent: patrol')
  assert.equal(actionSummary({ action: 'say', text: malicious }), `say · ${malicious}`)
  assert.equal(typeof actionSummary({ action: malicious }), 'string')
})

test('orderedRules sorts priority descending without mutating document data', async () => {
  const { orderedRules } = await studioPromise
  const malicious = '<svg onload=alert(1)>'
  const document = {
    metadata: { name: malicious },
    rules: [
      { id: 'low', priority: 2 },
      { id: malicious, priority: 20 },
      { id: 'same', priority: 20 },
    ],
  }

  const rules = orderedRules(document)
  assert.deepEqual(rules.map((rule) => rule.id), [malicious, 'same', 'low'])
  assert.deepEqual(document.rules.map((rule) => rule.id), ['low', malicious, 'same'])
  assert.equal(rules[0].id, malicious, 'untrusted IDs remain data for textContent, not generated HTML')
})

test('cappedAppend retains only the newest trace entries', async () => {
  const { cappedAppend } = await studioPromise
  const history = Array.from({ length: 100 }, (_, index) => index)

  assert.deepEqual(cappedAppend(history, 100, 100), Array.from({ length: 100 }, (_, index) => index + 1))
  assert.equal(history.length, 100)
})

test('normalizeTrace flattens a worker feed batch into drawable entries', async () => {
  const { normalizeTrace } = await studioPromise
  const batch = [
    { s: 1, t: 1700000000000, k: 'worker', m: '{"rule":"hunt","actions":[{"type":"attack","monster_id":"slime-1"}]}' },
    { s: 2, t: 1700000000500, k: 'worker', m: 'not json' },
  ]

  const entries = normalizeTrace(batch)
  assert.equal(entries.length, 2)
  assert.deepEqual(entries[0], {
    timestamp: 1700000000000,
    matchedRuleId: 'hunt',
    actions: [{ type: 'attack', monster_id: 'slime-1' }],
    note: '',
  })
  assert.deepEqual(entries[1].actions, [])
  assert.equal(entries[1].note, 'not json')
  assert.deepEqual(normalizeTrace(undefined), [])
})

test('actionSummary reads the canonical action the worker feed emits', async () => {
  const { actionSummary } = await studioPromise

  assert.equal(actionSummary({ type: 'attack', monster_id: 'slime-1' }), 'attack · "slime-1"')
  assert.equal(actionSummary({ type: 'wait' }), 'wait')
})
