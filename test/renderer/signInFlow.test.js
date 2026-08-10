'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

// signInFlow.js reads `window.agentApp` at module load time (the renderer's
// system boundary, exposed by preload.js in the real app) — stub it before
// import so the pure profileStatus reading can be exercised outside a browser.
global.window = global.window || { agentApp: {} }

const signInFlowPromise = import('../../src/renderer/signInFlow.js')

// The row's dot and the status line under the list both read this one function,
// because they used to format validation state separately and disagree — the
// row claiming "Verified" while the line explained it had never been checked.
test('a verified profile reads as lit, with when it was checked', async () => {
  const { profileStatus } = await signInFlowPromise
  const status = profileStatus({ validation: { ok: true, checkedAt: Date.now() - 5 * 60_000 } })
  assert.equal(status.tone, 'ok')
  assert.equal(status.label, 'Verified')
  assert.equal(status.detail, 'Verified 5 minutes ago')
})

// Coarsest unit that still says something, and a floor of "just now" so a check
// that finished a second ago does not read as "0 minutes ago".
test('staleness is stated in the largest unit that applies', async () => {
  const { agoLabel } = await signInFlowPromise
  const now = Date.parse('2026-08-10T12:00:00Z')
  assert.equal(agoLabel(now - 20_000, now), 'just now')
  assert.equal(agoLabel(now - 4 * 60_000, now), '4 minutes ago')
  assert.equal(agoLabel(now - 3 * 3600_000, now), '3 hours ago')
  assert.equal(agoLabel(now - 5 * 86400_000, now), '5 days ago')
  // A clock that moved backwards must not print "in 2 days".
  assert.equal(agoLabel(now - 400 * 86400_000, now), '400 days ago')
})

test('a refused profile carries the server error, not a summary of it', async () => {
  const { profileStatus } = await signInFlowPromise
  const status = profileStatus({ validation: { error: 'getaddrinfo ENOTFOUND realm.example' } })
  assert.equal(status.tone, 'bad')
  assert.equal(status.label, 'Unreachable')
  assert.equal(status.detail, 'getaddrinfo ENOTFOUND realm.example')
})

// `ok: false` with no error string is still "we have not established this
// works", so it must not fall through to the verified branch.
test('a never-checked profile is unknown rather than broken', async () => {
  const { profileStatus } = await signInFlowPromise
  for (const profile of [{}, { validation: null }, { validation: { ok: false } }]) {
    const status = profileStatus(profile)
    assert.equal(status.tone, 'unknown')
    assert.equal(status.label, 'Not verified')
  }
})
