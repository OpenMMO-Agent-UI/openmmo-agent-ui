'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { WebSocketServer } = require('ws')

require.cache[require.resolve('../src/runtimeEnv')] = {
  exports: { protocolVersion: () => 0, stampLayoutVersion: () => 0 },
}

const { characterFromWire, openSession } = require('../src/characterSession')
const { encode, decode, variantOf } = require('../src/msgpack')

const attributes = [10, 10, 10, 10, 10, 10]
const wireCharacter = (id, deletionDueAt = null) =>
  [id, deletionDueAt, `Hero${id}`, 1700000000, 12, 3400, 150, attributes, 'Knight', 'Female', [], [], null]

test('characterFromWire reads the positional Character layout including deletion_due_at', () => {
  assert.deepEqual(characterFromWire(wireCharacter(7)), {
    id: 7,
    deletionDueAt: null,
    name: 'Hero7',
    createdAt: 1700000000,
    level: 12,
    xp: 3400,
    maxHp: 150,
    attributes,
    class: 'Knight',
    gender: 'Female',
  })
})

async function fakeServer(reply) {
  const server = new WebSocketServer({ port: 0 })
  await new Promise((resolve) => server.once('listening', resolve))
  server.on('connection', (ws) => {
    ws.on('message', (data) => {
      const [name, body] = variantOf(decode(data))
      const answer = reply(name, body)
      if (answer) ws.send(encode(answer))
    })
  })
  return {
    url: `ws://127.0.0.1:${server.address().port}`,
    close: () => {
      for (const client of server.clients) client.terminate()
      server.close()
    },
  }
}

function deletionServer(onDelete) {
  return fakeServer((name, body) => {
    if (name === 'Authenticate') return { AuthSuccess: ['player', [wireCharacter(1, 1800000000), wireCharacter(2)]] }
    if (name === 'DeleteCharacter') return onDelete(body[0])
    if (name === 'CancelCharacterDeletion') return { CharacterDeletionCancelled: [body[0]] }
    return null
  })
}

test('a scheduled deletion resolves to its due time, and an immediate one to null', async (t) => {
  const server = await deletionServer((id) =>
    id === 2 ? { CharacterDeletionScheduled: [id, 1800000000] } : { CharacterDeleted: [id] },
  )
  t.after(server.close)
  const session = await openSession(server.url, 'token')
  t.after(session.close)

  assert.equal(session.characters[0].deletionDueAt, 1800000000)
  assert.equal(await session.deleteCharacter(2), 1800000000)
  assert.equal(await session.deleteCharacter(3), null)
  await session.cancelCharacterDeletion(1)
})

test('a refused deletion carries the server message', async (t) => {
  const server = await deletionServer(() => ({ CharacterError: ['Not your character'] }))
  t.after(server.close)
  const session = await openSession(server.url, 'token')
  t.after(session.close)

  await assert.rejects(session.deleteCharacter(9), /Not your character/)
})

test('a silent server fails sign-in as a timeout, not an undecodable frame', async (t) => {
  const server = await fakeServer(() => null)
  t.after(server.close)
  await assert.rejects(openSession(server.url, 'token', { replyTimeoutMs: 50 }), {
    message: 'The server did not respond to sign-in',
  })
})
