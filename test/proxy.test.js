'use strict'

const test = require('node:test')
const assert = require('node:assert')

const { AgentProxy } = require('../src/proxy')
const { encode, decode, variantOf, Float } = require('../src/msgpack')

const F = (n) => new Float(n)

function playerArray(id, position, name = 'Neighbour') {
  return [id, name, position.map(F), F(0), 1, 100, 100, 'knight', 'male', false, false, 0]
}

function monsterArray(id, position) {
  return [id, 'goblin', position.map(F), F(0), 'Idle', null, 10, 10, 0, null, false]
}

function groundItemArray(instanceId, position) {
  return [instanceId, 'iron_sword', position.map(F), 0, 0]
}

const joinSuccessFrame = (id, position) => encode({ JoinSuccess: [playerArray(id, position, 'TestChar'), false] })
const playerMoveFrame = (position) => encode({ PlayerMove: [position.map(F), F(0), 0] })
const monsterSpawnedFrame = (id, position) => encode({ MonsterSpawned: [monsterArray(id, position)] })
const monsterMovedFrame = (id, p) => encode({ MonsterMoved: [id, p.map(F), F(0), 'Chase', p.map(F), null] })
const playerAppearedFrame = (id, position) => encode({ PlayerAppeared: [playerArray(id, position)] })
const otherPlayerMovedFrame = (id, p) => encode({ PlayerMoved: [id, p.map(F), F(0), 0] })
const groundItemAppearedFrame = (id, p) => encode({ GroundItemAppeared: [groundItemArray(id, p)] })

/// The bulk baseline the server sends once at join (its add_player).
const gameStateFrame = ({ players = [], monsters = {}, groundItems = [] }) =>
  encode({ GameState: [players, monsters, groundItems] })

const namesOf = (frames) => frames.map((raw) => variantOf(decode(raw))[0])
const decodedOf = (frames) => frames.map((raw) => variantOf(decode(raw)))

/// Replays every frame a (re)connecting spectator is handed, in order, and
/// reports where the agent's own character ends up — the way the real client
/// processes JoinSuccess and then any PlayerMoved that follows.
function finalPosition(frames) {
  let position = null
  for (const [name, body] of decodedOf(frames)) {
    if (name === 'JoinSuccess') position = body[0][2]
    if (name === 'PlayerMoved') position = body[1]
  }
  return position
}

function finalMonsterPosition(frames, id) {
  let position = null
  for (const [name, body] of decodedOf(frames)) {
    if (name === 'MonsterSpawned' && body[0][0] === id) position = body[0][2]
    if (name === 'GameState' && body[1] && body[1][id]) position = body[1][id][2]
    if (name === 'MonsterMoved' && body[0] === id) position = body[1]
  }
  return position
}

function finalOtherPlayerPosition(frames, id) {
  let position = null
  for (const [name, body] of decodedOf(frames)) {
    if (name === 'PlayerAppeared' && body[0][0] === id) position = body[0][2]
    if (name === 'PlayerMoved' && body[0] === id) position = body[1]
  }
  return position
}

function assertNear(actual, expected) {
  assert.ok(Array.isArray(actual), `expected a position, got ${JSON.stringify(actual)}`)
  assert.strictEqual(actual.length, expected.length)
  // f32 on the wire (msgpack.js's Float), so compare with tolerance — the
  // logic under test is which position wins, not float precision.
  actual.forEach((n, i) => {
    assert.ok(Math.abs(n - expected[i]) < 0.01, `${JSON.stringify(actual)} !~= ${JSON.stringify(expected)}`)
  })
}

/// A stand-in for a connected spectator: readyState 1 is WebSocket.OPEN.
function fakeSpectator() {
  const sent = []
  return { readyState: 1, send: (f) => sent.push(f), sent }
}

// ---------- positions ----------

test('a spectator reconnecting after the agent moved sees the current position, not the stale join-time one', () => {
  const proxy = new AgentProxy()
  proxy.onServerFrame(joinSuccessFrame(42, [-1504.3, 0.0, 4736.5]))
  // Nobody is watching: switching 3D → Map tore the old /mirror socket down.
  // The move still has to be recorded, or switching back replays stale data.
  proxy.onAgentFrame(playerMoveFrame([-1588.3, 1.0, 4701.3]))

  assertNear(finalPosition(proxy.snapshot.frames()), [-1588.3, 1.0, 4701.3])
})

test('a spectator connecting before the agent has ever moved sees the join position', () => {
  const proxy = new AgentProxy()
  proxy.onServerFrame(joinSuccessFrame(42, [-1504.3, 0.0, 4736.5]))

  assertNear(finalPosition(proxy.snapshot.frames()), [-1504.3, 0.0, 4736.5])
})

test('a monster that moved after spawning is replayed at its current position', () => {
  const proxy = new AgentProxy()
  proxy.onServerFrame(joinSuccessFrame(42, [0, 0, 0]))
  proxy.onServerFrame(monsterSpawnedFrame('m1', [10, 0, 10]))
  proxy.onServerFrame(monsterMovedFrame('m1', [40, 0, 45]))

  assertNear(finalMonsterPosition(proxy.snapshot.frames(), 'm1'), [40, 0, 45])
})

test('another player who moved after appearing is replayed at their current position', () => {
  const proxy = new AgentProxy()
  proxy.onServerFrame(joinSuccessFrame(42, [0, 0, 0]))
  proxy.onServerFrame(playerAppearedFrame(7, [10, 0, 10]))
  proxy.onServerFrame(otherPlayerMovedFrame(7, [40, 0, 45]))

  assertNear(finalOtherPlayerPosition(proxy.snapshot.frames(), 7), [40, 0, 45])
})

test('a teleport of the agent’s own character updates its tracked position', () => {
  const proxy = new AgentProxy()
  proxy.onServerFrame(joinSuccessFrame(42, [-1588.3, 1.0, 4701.3]))
  // scroll_of_return: the one way self position changes without an outbound
  // PlayerMove for onAgentFrame to see.
  proxy.onServerFrame(encode({ PlayerTeleported: [42, [-1473.5, 1.1, 4732.8].map(F), F(0), 0] }))

  assertNear(finalPosition(proxy.snapshot.frames()), [-1473.5, 1.1, 4732.8])
})

test('a server position correction updates the tracked self position', () => {
  const proxy = new AgentProxy()
  proxy.onServerFrame(joinSuccessFrame(42, [0, 0, 0]))
  proxy.onAgentFrame(playerMoveFrame([500, 0, 500]))
  proxy.onServerFrame(encode({ PositionCorrected: [[12, 0, 12].map(F), F(0), 0] }))

  assertNear(finalPosition(proxy.snapshot.frames()), [12, 0, 12])
})

// ---------- other per-entity state ----------

test('health and torch state survive a reconnect', () => {
  const proxy = new AgentProxy()
  proxy.onServerFrame(joinSuccessFrame(42, [0, 0, 0]))
  proxy.onServerFrame(playerAppearedFrame(7, [10, 0, 10]))
  proxy.onServerFrame(encode({ PlayerHealthUpdate: [7, 31, 100] }))
  proxy.onServerFrame(encode({ PlayerTorchToggled: [7, true] }))

  const frames = decodedOf(proxy.snapshot.frames())
  assert.deepStrictEqual(frames.find(([n]) => n === 'PlayerHealthUpdate')[1], [7, 31, 100])
  assert.deepStrictEqual(frames.find(([n]) => n === 'PlayerTorchToggled')[1], [7, true])
})

test('a respawn replaces the death that preceded it rather than replaying both', () => {
  const proxy = new AgentProxy()
  proxy.onServerFrame(joinSuccessFrame(42, [0, 0, 0]))
  proxy.onServerFrame(playerAppearedFrame(7, [10, 0, 10]))
  proxy.onServerFrame(encode({ PlayerDead: [7] }))
  proxy.onServerFrame(encode({ PlayerRespawned: [playerArray(7, [1, 0, 1])] }))

  const names = namesOf(proxy.snapshot.frames())
  assert.ok(names.includes('PlayerRespawned'), `expected PlayerRespawned, got ${names.join(', ')}`)
  assert.ok(!names.includes('PlayerDead'), `PlayerDead should be superseded, got ${names.join(', ')}`)
})

test('ground items are replayed, and a picked-up one is not', () => {
  const proxy = new AgentProxy()
  proxy.onServerFrame(joinSuccessFrame(42, [0, 0, 0]))
  proxy.onServerFrame(groundItemAppearedFrame(900, [5, 0, 5]))
  proxy.onServerFrame(groundItemAppearedFrame(901, [6, 0, 6]))
  proxy.onServerFrame(encode({ GroundItemRemoved: [900] }))

  const ids = decodedOf(proxy.snapshot.frames())
    .filter(([n]) => n === 'GroundItemAppeared')
    .map(([, b]) => b[0][0])
  assert.deepStrictEqual(ids, [901], 'only the item still on the ground should be replayed')
})

test('shop and dungeon state are kept per place, not clobbered by the next one', () => {
  const proxy = new AgentProxy()
  proxy.onServerFrame(joinSuccessFrame(42, [0, 0, 0]))
  proxy.onServerFrame(encode({ ShopState: [11, 'Rica', ['iron_sword'], 60, []] }))
  proxy.onServerFrame(encode({ ShopState: [12, 'Karl', ['old_boot'], 50, []] }))
  proxy.onServerFrame(encode({ DungeonDoorsState: ['crypt', [[0, 1]]] }))

  const frames = proxy.snapshot.frames()
  const shops = decodedOf(frames)
    .filter(([n]) => n === 'ShopState')
    .map(([, b]) => b[0])
  assert.deepStrictEqual(shops.sort(), [11, 12], 'both merchants should survive')
  assert.ok(namesOf(frames).includes('DungeonDoorsState'))
})

// ---------- the join-time bulk baseline ----------

test('an entity known only from the join baseline still gets its movement tracked', () => {
  const proxy = new AgentProxy()
  proxy.onServerFrame(joinSuccessFrame(42, [0, 0, 0]))
  proxy.onServerFrame(gameStateFrame({ monsters: { m9: monsterArray('m9', [10, 0, 10]) } }))
  // No MonsterSpawned for m9 ever arrived, so the guard has to accept this
  // or the move is silently dropped.
  proxy.onServerFrame(monsterMovedFrame('m9', [70, 0, 80]))

  const frames = proxy.snapshot.frames()
  assert.ok(namesOf(frames).includes('GameState'), 'baseline should be replayed')
  assertNear(finalMonsterPosition(frames, 'm9'), [70, 0, 80])
})

test('the baseline is replayed before anything that corrects it', () => {
  const proxy = new AgentProxy()
  proxy.onServerFrame(joinSuccessFrame(42, [0, 0, 0]))
  proxy.onServerFrame(gameStateFrame({ monsters: { m9: monsterArray('m9', [10, 0, 10]) } }))
  proxy.onServerFrame(monsterMovedFrame('m9', [70, 0, 80]))

  const names = namesOf(proxy.snapshot.frames())
  assert.ok(names.indexOf('GameState') < names.indexOf('MonsterMoved'), `got ${names.join(', ')}`)
})

test('an entity that left after the join baseline has its departure replayed', () => {
  const proxy = new AgentProxy()
  proxy.onServerFrame(joinSuccessFrame(42, [0, 0, 0]))
  proxy.onServerFrame(gameStateFrame({ players: [playerArray(7, [10, 0, 10])] }))
  // The baseline is opaque and replayed verbatim, so merely forgetting
  // player 7 would leave them standing there forever.
  proxy.onServerFrame(encode({ PlayerLeft: [7] }))

  const names = namesOf(proxy.snapshot.frames())
  assert.ok(names.includes('PlayerLeft'), `departure must be replayed, got ${names.join(', ')}`)
  assert.ok(names.indexOf('GameState') < names.indexOf('PlayerLeft'), `got ${names.join(', ')}`)
})

// ---------- invariants ----------

test('every entity is introduced before the frame that repositions it', () => {
  const proxy = new AgentProxy()
  proxy.onServerFrame(joinSuccessFrame(42, [0, 0, 0]))
  proxy.onServerFrame(monsterSpawnedFrame('m1', [10, 0, 10]))
  proxy.onServerFrame(playerAppearedFrame(7, [10, 0, 10]))
  proxy.onServerFrame(monsterMovedFrame('m1', [40, 0, 45]))
  proxy.onServerFrame(otherPlayerMovedFrame(7, [40, 0, 45]))

  const seen = namesOf(proxy.snapshot.frames())
  assert.ok(seen.indexOf('PlayerAppeared') < seen.indexOf('PlayerMoved'), `got ${seen.join(', ')}`)
  assert.ok(seen.indexOf('MonsterSpawned') < seen.indexOf('MonsterMoved'), `got ${seen.join(', ')}`)
})

test('a removed entity leaves no orphan frame behind', () => {
  const proxy = new AgentProxy()
  proxy.onServerFrame(joinSuccessFrame(42, [0, 0, 0]))
  proxy.onServerFrame(monsterSpawnedFrame('m1', [10, 0, 10]))
  proxy.onServerFrame(monsterMovedFrame('m1', [40, 0, 45]))
  proxy.onServerFrame(encode({ MonsterRemoved: ['m1'] }))

  const names = namesOf(proxy.snapshot.frames())
  assert.ok(!names.includes('MonsterMoved'), `got ${names.join(', ')}`)
  assert.ok(!names.includes('MonsterSpawned'), `got ${names.join(', ')}`)
})

test('each outbound move is broadcast live to attached spectators', () => {
  const proxy = new AgentProxy()
  proxy.onServerFrame(joinSuccessFrame(42, [0, 0, 0]))
  const spy = fakeSpectator()
  proxy.spectators.add(spy)

  proxy.onAgentFrame(playerMoveFrame([10, 0, 10]))
  proxy.onAgentFrame(playerMoveFrame([20, 0, 20]))
  proxy.onAgentFrame(playerMoveFrame([30, 0, 30]))

  const moves = decodedOf(spy.sent).filter(([n]) => n === 'PlayerMoved')
  assert.strictEqual(moves.length, 3, `every move should reach the spectator, got ${spy.sent.length} frames`)
  assert.strictEqual(moves[2][1][0], 42, 'broadcast must carry the agent player id')
  assertNear(moves[2][1][1], [30, 0, 30])
})
