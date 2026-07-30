'use strict'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')

const { candidateBinaries } = require('../src/agent')

const exe = process.platform === 'win32' ? 'agent-client.exe' : 'agent-client'

test('a packaged build ignores a legacy external binary override', () => {
  assert.deepStrictEqual(candidateBinaries('/old/v9/agent-client', true, '/bundle/resources', '/checkout'), [
    path.join('/bundle/resources', 'agent-client', exe),
  ])
})

test('a dev checkout still honors a manual binary override', () => {
  assert.deepStrictEqual(candidateBinaries('/custom/agent-client', false, '/unused', '/checkout'), [
    '/custom/agent-client',
    path.join('/checkout', 'target', 'release', exe),
    path.join('/checkout', 'target', 'debug', exe),
  ])
})
