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
  // Nobody is watching: a reload tore the old /mirror socket down. The move
  // still has to be recorded, or the new one replays stale data.
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

test('monsters the agent drives are broadcast live and tracked for reconnects', () => {
  const proxy = new AgentProxy()
  proxy.onServerFrame(joinSuccessFrame(42, [0, 0, 0]))
  proxy.onServerFrame(monsterSpawnedFrame('m1', [10, 0, 10]))

  const spy = fakeSpectator()
  proxy.spectators.add(spy)
  // The agent runs the AI for monsters assigned to it and sends MonsterMove;
  // the server never echoes that back to the owner, so the relay is the only
  // place it can be seen.
  proxy.onAgentFrame(
    encode({ MonsterMove: ['m1', [40, 0, 45].map(F), F(0), 'Chase', [50, 0, 55].map(F)] }),
  )

  const moves = decodedOf(spy.sent).filter(([n]) => n === 'MonsterMoved')
  assert.strictEqual(moves.length, 1, 'the move should reach the spectator live')
  assertNear(moves[0][1][1], [40, 0, 45])
  assert.strictEqual(moves[0][1][5], 42, 'owner_id should be the agent, as the server would have stamped it')
  assertNear(finalMonsterPosition(proxy.snapshot.frames(), 'm1'), [40, 0, 45])
})

test('an agent move for a monster the spectator was never introduced to is not replayed', () => {
  const proxy = new AgentProxy()
  proxy.onServerFrame(joinSuccessFrame(42, [0, 0, 0]))
  // MonsterAssigned is OWNER_ONLY, so a monster known to the agent only that
  // way was never announced to spectators — a move naming it would be an
  // orphan. It is still broadcast live (harmless, and the client may know it
  // by another route), but must not be baked into the catch-up snapshot.
  proxy.onAgentFrame(
    encode({ MonsterMove: ['ghost', [1, 0, 1].map(F), F(0), 'Idle', [1, 0, 1].map(F)] }),
  )

  const names = namesOf(proxy.snapshot.frames())
  assert.ok(!names.includes('MonsterMoved'), `got ${names.join(', ')}`)
})

/// `PlayerInventory` on the wire: [bag, equipped], each `ItemInstance` being
/// [instance_id, item_def_id, quantity, enchant] and `equipped` keyed by
/// EquipSlot's serde names.
const inventoryFrame = (name, bag, equipped) => encode({ [name]: [[bag, equipped]] })

test('what the character is wearing is read off the inventory frames', () => {
  const worn = []
  const proxy = new AgentProxy(() => {}, (w) => worn.push(w))
  proxy.onServerFrame(joinSuccessFrame(42, [0, 0, 0]))
  proxy.onServerFrame(
    inventoryFrame('InventoryState', [[7, 'bread', 2, 0]], {
      main_hand: [1, 'iron_sword', 1, 2],
      chest: [2, 'breastplate', 1, 0],
    }),
  )

  assert.deepStrictEqual(worn.at(-1), {
    main_hand: { itemDefId: 'iron_sword', quantity: 1, enchant: 2 },
    chest: { itemDefId: 'breastplate', quantity: 1, enchant: 0 },
  })
})

test('every later inventory mutation restates the gear, not just the join-time frame', () => {
  const worn = []
  const proxy = new AgentProxy(() => {}, (w) => worn.push(w))
  proxy.onServerFrame(inventoryFrame('InventoryState', [], { main_hand: [1, 'iron_sword', 1, 0] }))
  // Equipping happens through InventoryUpdated; a panel that only watched
  // InventoryState would show the join-time gear for the rest of the session.
  proxy.onServerFrame(
    inventoryFrame('InventoryUpdated', [], {
      main_hand: [1, 'iron_sword', 1, 0],
      head: [3, 'leather_cap', 1, 0],
    }),
  )

  assert.deepStrictEqual(Object.keys(worn.at(-1)).sort(), ['head', 'main_hand'])
})

/// Enough of a socket for attachAgent to wire up and then tear down; the
/// upstream it dials is a closed port, which fails into the same close path.
function fakeAgentSocket() {
  return {
    readyState: 1,
    handlers: {},
    on(event, fn) { this.handlers[event] = fn },
    off() {},
    send() {},
    close() { this.readyState = 3 },
  }
}

test('a new agent session clears the gear the previous one was wearing', () => {
  const worn = []
  const proxy = new AgentProxy(() => {}, (w) => worn.push(w))
  proxy.onServerFrame(inventoryFrame('InventoryState', [], { head: [3, 'leather_cap', 1, 0] }))
  assert.deepStrictEqual(Object.keys(worn.at(-1)), ['head'])

  proxy.upstreamUrl = 'ws://127.0.0.1:1/ws'
  proxy.attachAgent(fakeAgentSocket())

  assert.deepStrictEqual(worn.at(-1), {}, 'attaching a fresh agent should empty the panel')
  proxy.stop()
})

test('an inventory frame in a shape we cannot read is ignored, not reported as naked', () => {
  const worn = []
  const proxy = new AgentProxy(() => {}, (w) => worn.push(w))
  proxy.onServerFrame(encode({ InventoryState: ['not-an-inventory'] }))

  assert.strictEqual(worn.length, 0)
})

/// Both shapes verified against `rmp_serde::to_vec` on the real types:
/// `SkillsUpdate` wraps the map twice (the message struct, then `Skills`), its
/// keys are `SkillId`'s serde names, and `SkillProgress` is [level, xp].
const skillsUpdateFrame = (map) => encode({ SkillsUpdate: [[map]] })
/// [skill, xp_amount, total_xp, new_level, leveled_up]
const skillXpFrame = (skill, xpAmount, totalXp, newLevel, leveledUp = false) =>
  encode({ SkillXpGained: [skill, xpAmount, totalXp, newLevel, leveledUp] })

test('trained skills are read off the join-time skills frame', () => {
  const skills = []
  const proxy = new AgentProxy(
    () => {},
    () => {},
    (s) => skills.push(s),
  )
  proxy.onServerFrame(skillsUpdateFrame({ fishing: [4, 1600] }))

  assert.deepStrictEqual(skills.at(-1), { fishing: { level: 4, xp: 1600 } })
})

test('an XP gain restates its own skill and leaves the others alone', () => {
  const skills = []
  const proxy = new AgentProxy(
    () => {},
    () => {},
    (s) => skills.push(s),
  )
  proxy.onServerFrame(skillsUpdateFrame({ fishing: [4, 1600], mining: [1, 100] }))
  // The gain carries the running totals, so the panel never has to re-derive
  // a level from the XP curve.
  proxy.onServerFrame(skillXpFrame('fishing', 900, 2500, 5, true))

  assert.deepStrictEqual(skills.at(-1), {
    fishing: { level: 5, xp: 2500 },
    mining: { level: 1, xp: 100 },
  })
})

/// [guard, cha] — the server's own effective_stats, sent on join and after
/// every equipment change.
const effectiveStatsFrame = (guard, cha) => encode({ EffectiveStatsUpdated: [guard, cha] })

test('the gear-fed guard and CHA are read off the effective-stats frame', () => {
  const stats = []
  const proxy = new AgentProxy(
    () => {},
    () => {},
    () => {},
    (s) => stats.push(s),
  )
  proxy.onServerFrame(effectiveStatsFrame(14, 11))

  assert.deepStrictEqual(stats.at(-1), { guard: 14, cha: 11 })
})

test('a new agent session clears the stats the previous one wore', () => {
  const stats = []
  const proxy = new AgentProxy(
    () => {},
    () => {},
    () => {},
    (s) => stats.push(s),
  )
  proxy.onServerFrame(effectiveStatsFrame(14, 11))

  proxy.upstreamUrl = 'ws://127.0.0.1:1/ws'
  proxy.attachAgent(fakeAgentSocket())

  assert.strictEqual(stats.at(-1), null, 'attaching a fresh agent should empty the strip')
  proxy.stop()
})

test('an effective-stats frame in a shape we cannot read is ignored', () => {
  const stats = []
  const proxy = new AgentProxy(
    () => {},
    () => {},
    () => {},
    (s) => stats.push(s),
  )
  proxy.onServerFrame(encode({ EffectiveStatsUpdated: ['fourteen', null] }))

  assert.strictEqual(stats.length, 0)
})

test('a new agent session clears the skills the previous one had trained', () => {
  const skills = []
  const proxy = new AgentProxy(
    () => {},
    () => {},
    (s) => skills.push(s),
  )
  proxy.onServerFrame(skillsUpdateFrame({ fishing: [4, 1600] }))

  proxy.upstreamUrl = 'ws://127.0.0.1:1/ws'
  proxy.attachAgent(fakeAgentSocket())

  assert.deepStrictEqual(skills.at(-1), {}, 'attaching a fresh agent should empty the panel')
  // And the emptied map is what a later gain builds on, not the old session's.
  proxy.onServerFrame(skillXpFrame('fishing', 100, 100, 1))
  assert.deepStrictEqual(skills.at(-1), { fishing: { level: 1, xp: 100 } })
  proxy.stop()
})

test('a skills frame in a shape we cannot read is ignored, not reported as untrained', () => {
  const skills = []
  const proxy = new AgentProxy(
    () => {},
    () => {},
    (s) => skills.push(s),
  )
  proxy.onServerFrame(encode({ SkillsUpdate: ['not-a-skill-map'] }))
  proxy.onServerFrame(encode({ SkillXpGained: [null, 1, 1, 1, false] }))

  assert.strictEqual(skills.length, 0)
})
