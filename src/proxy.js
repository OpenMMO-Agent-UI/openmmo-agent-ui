'use strict'

const http = require('node:http')
const { WebSocket, WebSocketServer } = require('ws')

const { encode, decode, variantOf, Float } = require('./msgpack')

/// Sits between agent-client and the game server, on loopback:
///
///   agent-client <--ws--> proxy <--wss--> openmmo.to.nexus
///                           |
///                           +--> spectators (/mirror)
///
/// Everything is relayed byte for byte, so the server cannot tell the agent is
/// behind anything. Being in the middle is what makes the spectator view
/// possible without patching agent-client: we see the agent's own outbound
/// moves, which the server never echoes back to it, and can hand spectators
/// the `PlayerMoved` its neighbours would have received.

/// Messages that belong to the connection that owns them. A spectator that
/// adopted monsters would run a second AI for creatures the agent drives.
const OWNER_ONLY = new Set([
  'MonsterAssigned',
  'SpawnMonsterRequest',
  'AuthSuccess',
  'CharacterCreated',
  'CharacterStatsRolled',
  'CharacterDeleted',
  'CharacterError',
])

/// Field 0 of each body is the entity id — structs are positional arrays, and
/// `Player.id` / `Monster.id` are declared first in both.
const ADD_PLAYER = new Set(['PlayerAppeared', 'PlayerJoined'])
const DROP_PLAYER = new Set(['PlayerDisappeared', 'PlayerLeft'])
const ADD_MONSTER = new Set(['MonsterSpawned'])
const DROP_MONSTER = new Set(['MonsterRemoved', 'MonsterDead'])

/// What a spectator needs replayed to draw a world it joined late.
class WorldSnapshot {
  constructor() {
    this.reset()
  }

  reset() {
    this.selfPlayerId = null
    this.selfFloor = 0
    this.join = null
    this.players = new Map()
    this.monsters = new Map()
    this.singletons = new Map()
  }

  /// Record a server frame. `raw` is kept as-is so the replay is the very
  /// bytes the client already knows how to read.
  observe(name, body, raw) {
    if (name === 'JoinSuccess') {
      const player = body && body[0]
      if (Array.isArray(player)) this.selfPlayerId = player[0]
      this.join = raw
      this.players.clear()
      this.monsters.clear()
      return
    }
    if (ADD_PLAYER.has(name)) {
      const player = body && body[0]
      if (Array.isArray(player) && player[0] !== this.selfPlayerId) {
        this.players.set(player[0], raw)
      }
      return
    }
    if (DROP_PLAYER.has(name)) {
      this.players.delete(body && body[0])
      return
    }
    if (ADD_MONSTER.has(name)) {
      const monster = body && body[0]
      if (Array.isArray(monster)) this.monsters.set(monster[0], raw)
      return
    }
    if (DROP_MONSTER.has(name)) {
      this.monsters.delete(body && body[0])
      return
    }
    // One-of-a-kind state where only the latest matters.
    if (name === 'GoldUpdate' || name === 'InventoryState' || name === 'GameTimeSync') {
      this.singletons.set(name, raw)
    }
  }

  frames() {
    const out = []
    if (this.join) out.push(this.join)
    out.push(...this.players.values(), ...this.monsters.values(), ...this.singletons.values())
    return out
  }
}

class AgentProxy {
  constructor() {
    this.server = null
    this.wss = null
    this.port = 0
    this.upstreamUrl = ''
    this.snapshot = new WorldSnapshot()
    this.spectators = new Set()
    this.agentSocket = null
  }

  get agentUrl() {
    return this.port ? `ws://127.0.0.1:${this.port}/ws` : null
  }

  get mirrorUrl() {
    return this.port ? `ws://127.0.0.1:${this.port}/mirror` : null
  }

  async start(upstreamUrl) {
    this.upstreamUrl = upstreamUrl
    if (this.server) return this.agentUrl

    this.server = http.createServer((_req, res) => {
      res.writeHead(426, { 'content-type': 'text/plain' })
      res.end('WebSocket only')
    })
    this.wss = new WebSocketServer({ noServer: true })

    this.server.on('upgrade', (req, socket, head) => {
      const path = (req.url || '').split('?')[0]
      if (path !== '/ws' && path !== '/mirror') {
        socket.destroy()
        return
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        if (path === '/ws') this.attachAgent(ws)
        else this.attachSpectator(ws)
      })
    })

    await new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', resolve)
    })
    this.port = this.server.address().port
    return this.agentUrl
  }

  /// One agent at a time: agent-client opens a single session, and a second
  /// one would be a stale reconnect racing the live one.
  attachAgent(downstream) {
    if (this.agentSocket) this.agentSocket.close()
    this.agentSocket = downstream
    this.snapshot.reset()

    const upstream = new WebSocket(this.upstreamUrl)
    const pending = []

    upstream.on('open', () => {
      for (const frame of pending) upstream.send(frame)
      pending.length = 0
    })

    downstream.on('message', (data) => {
      const frame = toBuffer(data)
      if (upstream.readyState === WebSocket.OPEN) upstream.send(frame)
      else pending.push(frame)
      this.onAgentFrame(frame)
    })

    upstream.on('message', (data) => {
      const frame = toBuffer(data)
      if (downstream.readyState === WebSocket.OPEN) downstream.send(frame)
      this.onServerFrame(frame)
    })

    const closeBoth = () => {
      if (this.agentSocket === downstream) this.agentSocket = null
      if (upstream.readyState <= WebSocket.OPEN) upstream.close()
      if (downstream.readyState <= WebSocket.OPEN) downstream.close()
    }
    upstream.on('close', closeBoth)
    upstream.on('error', closeBoth)
    downstream.on('close', closeBoth)
    downstream.on('error', closeBoth)
  }

  attachSpectator(ws) {
    this.spectators.add(ws)
    for (const frame of this.snapshot.frames()) ws.send(frame)
    // A spectator cannot act, but it still speaks first (the client sends its
    // protocol handshake on open); read and drop so the socket stays healthy.
    ws.on('message', () => {})
    const drop = () => this.spectators.delete(ws)
    ws.on('close', drop)
    ws.on('error', drop)
  }

  broadcast(frame) {
    for (const ws of this.spectators) {
      if (ws.readyState === WebSocket.OPEN) ws.send(frame)
    }
  }

  onServerFrame(frame) {
    const [name, body] = safeVariant(frame)
    if (!name) return
    this.snapshot.observe(name, body, frame)
    if (!OWNER_ONLY.has(name)) this.broadcast(frame)
  }

  /// The agent's own movement never comes back from the server, so a
  /// spectator would see a character that never walks. Turn each outbound
  /// PlayerMove into the PlayerMoved its neighbours receive.
  onAgentFrame(frame) {
    const [name, body] = safeVariant(frame)
    if (name !== 'PlayerMove' || !Array.isArray(body)) return
    const [position, rotation, floorLevel] = body
    if (!Array.isArray(position) || this.snapshot.selfPlayerId === null) return
    this.snapshot.selfFloor = typeof floorLevel === 'number' ? floorLevel : this.snapshot.selfFloor
    if (this.spectators.size === 0) return

    this.broadcast(
      encode({
        PlayerMoved: [
          this.snapshot.selfPlayerId,
          position.map((n) => new Float(n)),
          new Float(typeof rotation === 'number' ? rotation : 0),
          this.snapshot.selfFloor,
        ],
      }),
    )
  }

  stop() {
    for (const ws of this.spectators) ws.close()
    this.spectators.clear()
    if (this.agentSocket) this.agentSocket.close()
    this.agentSocket = null
    if (this.wss) this.wss.close()
    if (this.server) this.server.close()
    this.server = null
    this.wss = null
    this.port = 0
    this.snapshot.reset()
  }
}

function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data
  if (Array.isArray(data)) return Buffer.concat(data)
  return Buffer.from(data)
}

/// A protocol addition we cannot decode must never take the relay down: the
/// frame is still forwarded verbatim, we just learn nothing from it.
function safeVariant(frame) {
  try {
    return variantOf(decode(frame))
  } catch {
    return [null, null]
  }
}

module.exports = { AgentProxy, WorldSnapshot, OWNER_ONLY }
