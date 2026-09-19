'use strict'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')

const { AgentProcess, candidateBinaries } = require('../src/agent')

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

test('a tracing line is split into its parts, colour codes and all', () => {
  const agent = new AgentProcess()
  const items = []
  agent.on('log', (item) => items.push(item))
  agent.append(
    'err',
    '\x1b[2m2026-09-19T02:12:33.123456Z\x1b[0m \x1b[32m INFO\x1b[0m \x1b[2magent_client::driver::worker\x1b[0m\x1b[2m:\x1b[0m [npc_x] Worker: heading to town (bag 92%)\n' +
      'thread panicked\n',
  )
  agent.append('app', '$ agent-client')

  assert.deepStrictEqual(items[0], {
    stream: 'err',
    line: '2026-09-19T02:12:33.123456Z  INFO agent_client::driver::worker: [npc_x] Worker: heading to town (bag 92%)',
    t: Date.parse('2026-09-19T02:12:33.123456Z'),
    level: 'info',
    target: 'agent_client::driver::worker',
    msg: '[npc_x] Worker: heading to town (bag 92%)',
  })
  assert.deepStrictEqual(Object.keys(items[1]).sort(), ['line', 'stream', 't'], 'a plain line stays plain')
  assert.strictEqual(items[1].line, 'thread panicked')
  assert.strictEqual(items[2].stream, 'app')
})
