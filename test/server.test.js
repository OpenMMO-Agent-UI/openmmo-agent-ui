'use strict'

const test = require('node:test')
const assert = require('node:assert')

const { ClientServer, distReady } = require('../src/server')

test('concurrent starts share one listening server', { skip: !distReady() && 'client dist not built' }, async () => {
  const server = new ClientServer()
  try {
    const [a, b] = await Promise.all([server.start(null), server.start(null)])
    assert.match(a, /^http:\/\/127\.0\.0\.1:\d+$/)
    assert.equal(b, a)
  } finally {
    server.stop()
  }
})
