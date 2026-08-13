'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const domPromise = import('../../src/renderer/dom.js')

test('clampToBounds holds a value inside the bounds the input declares', async () => {
  const { clampToBounds } = await domPromise

  // Bounds arrive as DOM attribute strings, and an absent one reads as ''.
  assert.equal(clampToBounds(1, '3', '401'), 3)
  assert.equal(clampToBounds(4100, '3', '401'), 401)
  assert.equal(clampToBounds(41, '3', '401'), 41)
  assert.equal(clampToBounds(0.7, '0', '2'), 0.7)
  assert.equal(clampToBounds(99999, '', ''), 99999)
  assert.equal(clampToBounds(-5, '', '65535'), -5)
})

test('isAnswered treats an emptied box and a below-floor zero as no answer', async () => {
  const { isAnswered } = await domPromise

  assert.equal(isAnswered('', '3'), false)
  assert.equal(isAnswered('0', '3'), false)
  assert.equal(isAnswered('41', '3'), true)
  // Watch port 0 disables the mirror and Temperature 0 is deterministic.
  assert.equal(isAnswered('0', '0'), true)
  assert.equal(isAnswered('0', ''), true)
})
