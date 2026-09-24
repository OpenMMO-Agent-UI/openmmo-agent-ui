'use strict'

const http = require('node:http')
const { WebSocket, WebSocketServer } = require('ws')

const { encode, decode, variantOf, Float, endOf, arrayAt, arrayHeader } = require('./msgpack')

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
const ADD_GROUND_ITEM = new Set(['GroundItemSpawned', 'GroundItemAppeared'])

/// Movement, as distinct from first sighting. An `ADD_*` frame carries a
/// position that was only current at the moment the entity came into view, so
/// replaying those alone shows a spectator the world's first-sighting layout —
/// monsters back at their spawn points, players back where they walked in.
/// Field 0 of each of these is the entity id, same as the `ADD_*`/`DROP_*` sets.
const MOVE_PLAYER = new Set(['PlayerMoved', 'PlayerTeleported'])
const MOVE_MONSTER = new Set(['MonsterMoved'])

/// Per-entity state where only the latest frame matters. Messages that are
/// mutually exclusive share a slot, so a respawn replaces the death before it
/// instead of both being replayed; ones that are independent (how hurt you
/// are vs. whether your torch is lit) get their own.
const ENTITY_STATE_SLOT = new Map([
  ['PlayerDead', 'life'],
  ['PlayerRespawned', 'life'],
  ['PlayerHealthUpdate', 'health'],
  ['PlayerTorchToggled', 'torch'],
  ['PlayerInteractionChanged', 'interaction'],
  // Being on a horse is how fast the body moves, so a spectator that joins
  // mid-ride and is not told draws it at footpace and snaps forward for the
  // rest of the ride.
  ['PlayerMountChanged', 'mount'],
])

/// Truly one-of-a-kind state: one gold total, one bag, one clock.
const SINGLETON = new Set(['GoldUpdate', 'InventoryState', 'GameTimeSync'])

/// The two frames that carry a whole `PlayerInventory` — the join-time state
/// and every mutation after it. agent-client tracks both (its `self_equipped`)
/// but its panel API only publishes the bag, so what the character is *wearing*
/// is visible here and nowhere else. Same reason we watch outbound moves: the
/// relay sees everything the agent is told.
const INVENTORY = new Set(['InventoryState', 'InventoryUpdated'])

/// `PlayerInventory` is `[bag, equipped]`, and `equipped` is a map keyed by
/// `EquipSlot`'s serde names ("head", "main_hand", …) whose values are
/// `ItemInstance` = `[instance_id, item_def_id, quantity, enchant]`.
/// `SkillsUpdate` is `[Skills]` and `Skills` is `[learned]`: the permanently
/// learned skill ids (`SkillId`'s serde names, "fishing"), a set on the wire
/// as a list. There is no level or XP any more — a skill is had or not.
function skillsFromUpdate(body) {
  const learned = Array.isArray(body && body[0]) ? body[0][0] : null
  if (!Array.isArray(learned)) return null
  return learned.filter((id) => typeof id === 'string')
}

/// `AbilityRejected` is `[ability, reason]`, `AbilityCooldowns` is
/// `[[[ability, remaining_ms], …]]` — both direct replies to a `UseAbility`,
/// so they are what the drawer's Use button hears back.
function abilityFromReply(name, body) {
  if (name === 'AbilityRejected') {
    const [ability, reason] = body || []
    return typeof ability === 'string' ? { kind: 'rejected', ability, reason } : null
  }
  const timers = Array.isArray(body && body[0]) ? body[0] : null
  if (!timers) return null
  const cooldowns = {}
  for (const timer of timers) {
    if (Array.isArray(timer) && typeof timer[0] === 'string') cooldowns[timer[0]] = timer[1] ?? 0
  }
  return { kind: 'cooldowns', cooldowns }
}

/// `EffectiveStatsUpdated` is `[guard, cha]`: what combat and haggling
/// actually use, base attribute plus the bonuses the worn gear adds (the
/// server's effective_stats). The roster's rolled attributes never move, so
/// this frame is the only place a worn gold ring's +1 CHA is visible.
function statsFromEffective(body) {
  const [guard, cha] = body || []
  if (!Number.isFinite(guard) || !Number.isFinite(cha)) return null
  return { guard, cha }
}

function wornFromInventory(body) {
  const inventory = body && body[0]
  const equipped = Array.isArray(inventory) ? inventory[1] : null
  if (!equipped || typeof equipped !== 'object' || Array.isArray(equipped)) return null
  const worn = {}
  for (const [slot, item] of Object.entries(equipped)) {
    if (!Array.isArray(item)) continue
    worn[slot] = { itemDefId: item[1], quantity: item[2] ?? 1, enchant: item[3] ?? 0 }
  }
  return worn
}

/// `PlayerTitles` is `[titles, active]` — the earned title ids in definition
/// order and the one shown above the name, sent to the owner on entry and
/// after every change (doc/TITLES.md). Owner-private like skills, so the
/// relay is the only place the UI sees it.
function titlesFromUpdate(body) {
  const [titles, active] = body || []
  if (!Array.isArray(titles)) return null
  return { titles, active: active || null }
}

/// The title `JoinSuccess`'s Player carries (`Player.title`, shared/entity.rs),
/// or null. The entry `PlayerTitles` that follows it reads none whatever the
/// character wears, so this is where the worn pick is.
const PLAYER_TITLE_SLOT = 18
function titleFromJoin(body) {
  const player = body && body[0]
  const title = Array.isArray(player) ? player[PLAYER_TITLE_SLOT] : null
  return typeof title === 'string' && title ? title : null
}

/// `PlayerRespawned` carries a whole `Player` (so the id is nested at [0][0]);
/// every other per-entity state message carries the id directly at [0].
function entityStateId(name, body) {
  if (name === 'PlayerRespawned') return Array.isArray(body[0]) ? body[0][0] : null
  return body[0]
}

/// Location-scoped state — not one-of-a-kind (a shop per merchant, doors per
/// dungeon entrance, props per entrance *and* depth), so keyed by the place it
/// describes rather than by message name.
function placeKey(name, body) {
  if (name === 'ShopState') return `shop#${body[0]}`
  if (name === 'DungeonDoorsState') return `doors#${body[0]}`
  if (name === 'DungeonPropsState') return `props#${body[0]}#${body[1]}`
  return null
}

/// What a spectator needs replayed to draw a world it joined late.
class WorldSnapshot {
  constructor() {
    this.reset()
  }

  reset() {
    this.selfPlayerId = null
    this.selfPosition = null
    this.selfRotation = 0
    this.selfFloor = 0
    /// Whether the last step was a run. The client interpolates a mirrored
    /// character at the speed this flag picks (`remotePlayerManager`), so
    /// dropping it drew a sprinting agent at walking pace: the body fell
    /// 1.5 m/s behind its own frames until the spectator's 8 m desync guard
    /// snapped it forward, which is what "the character keeps teleporting"
    /// was.
    this.selfSprinting = false
    this.join = null
    /// The one `GameState` the server sends at join (server's add_player): a
    /// bulk baseline of everything already nearby. Always older than any
    /// incremental frame, so it is replayed first and everything below
    /// corrects it.
    this.baseline = null
    this.players = new Map()
    this.monsters = new Map()
    this.groundItems = new Map()
    // Ids we could replay an introduction for — from our own sightings *and*
    // from the baseline, since a correction for an entity seen only there
    // would otherwise be dropped by the guards in observe().
    this.knownPlayers = new Set()
    this.knownMonsters = new Set()
    // Departures we cannot express by simply forgetting: the entity was
    // introduced by the baseline frame, which is replayed verbatim and cannot
    // be edited, so the drop has to be replayed after it.
    this.playerDrops = new Map()
    this.monsterDrops = new Map()
    this.groundItemDrops = new Map()
    // Latest movement per entity, kept apart from the sighting frame above:
    // the sighting carries name/class/health, the movement carries where it
    // actually is now, and a spectator needs both.
    this.playerMoves = new Map()
    this.monsterMoves = new Map()
    this.entityState = new Map()
    this.places = new Map()
    this.singletons = new Map()
  }

  /// True for an entity we can replay an introduction for, so a correction
  /// referring to it will land rather than naming an id the spectator has
  /// never heard of. The agent itself counts: it is introduced by `join`.
  knowsPlayer(id) {
    return id === this.selfPlayerId || this.knownPlayers.has(id)
  }

  /// Record a server frame. `raw` is kept as-is so the replay is the very
  /// bytes the client already knows how to read.
  observe(name, body, raw) {
    if (name === 'JoinSuccess') {
      const player = body && body[0]
      if (Array.isArray(player)) {
        this.selfPlayerId = player[0]
        // Player is a positional struct (shared/entity.rs): [id, name,
        // position, rotation, ...] — index 2/3 regardless of what else is in it.
        if (Array.isArray(player[2])) this.selfPosition = player[2]
        if (typeof player[3] === 'number') this.selfRotation = player[3]
      }
      this.join = raw
      this.baseline = null
      this.players.clear()
      this.monsters.clear()
      this.groundItems.clear()
      this.knownPlayers.clear()
      this.knownMonsters.clear()
      this.playerDrops.clear()
      this.monsterDrops.clear()
      this.groundItemDrops.clear()
      this.playerMoves.clear()
      this.monsterMoves.clear()
      this.entityState.clear()
      this.places.clear()
      return
    }
    if (name === 'GameState') {
      this.baseline = raw
      for (const player of body[0] || []) {
        if (Array.isArray(player) && player[0] !== this.selfPlayerId) this.knownPlayers.add(player[0])
      }
      // `monsters` is a HashMap on the wire, so it decodes to an object keyed
      // by monster id; `ground_items` is a plain list.
      for (const id of Object.keys(body[1] || {})) this.knownMonsters.add(id)
      for (const item of body[2] || []) {
        if (Array.isArray(item)) this.groundItemDrops.delete(item[0])
      }
      return
    }
    if (ADD_PLAYER.has(name)) {
      const player = body && body[0]
      if (Array.isArray(player) && player[0] !== this.selfPlayerId) {
        this.players.set(player[0], raw)
        this.knownPlayers.add(player[0])
        this.playerDrops.delete(player[0])
      }
      return
    }
    if (DROP_PLAYER.has(name)) {
      const id = body && body[0]
      this.knownPlayers.delete(id)
      this.playerMoves.delete(id)
      for (const slot of ['life', 'health', 'torch', 'interaction']) this.entityState.delete(`${slot}#${id}`)
      // Forgetting our own sighting is enough; a baseline-introduced entity
      // needs the departure replayed instead.
      if (!this.players.delete(id)) this.playerDrops.set(id, raw)
      return
    }
    if (ADD_MONSTER.has(name)) {
      const monster = body && body[0]
      if (Array.isArray(monster)) {
        this.monsters.set(monster[0], raw)
        this.knownMonsters.add(monster[0])
        this.monsterDrops.delete(monster[0])
      }
      return
    }
    if (DROP_MONSTER.has(name)) {
      const id = body && body[0]
      this.knownMonsters.delete(id)
      this.monsterMoves.delete(id)
      if (!this.monsters.delete(id)) this.monsterDrops.set(id, raw)
      return
    }
    if (ADD_GROUND_ITEM.has(name)) {
      const item = body && body[0]
      if (Array.isArray(item)) {
        this.groundItems.set(item[0], raw)
        this.groundItemDrops.delete(item[0])
      }
      return
    }
    if (name === 'GroundItemRemoved') {
      const id = body && body[0]
      if (!this.groundItems.delete(id)) this.groundItemDrops.set(id, raw)
      return
    }
    if (MOVE_PLAYER.has(name)) {
      const id = body && body[0]
      // The agent's own movement is tracked separately (onAgentFrame sees the
      // outbound PlayerMove the server never echoes) — but a *teleport* does
      // come back from the server, and it's the one way self position changes
      // without an outbound move, so take it here.
      if (id !== null && id === this.selfPlayerId) this.takeSelfPosition(body[1], body[2], body[3])
      else if (this.knownPlayers.has(id)) this.playerMoves.set(id, raw)
      return
    }
    if (MOVE_MONSTER.has(name)) {
      const id = body && body[0]
      if (this.knownMonsters.has(id)) this.monsterMoves.set(id, raw)
      return
    }
    // Addressed to the agent alone and carrying no id: the server overriding
    // where it thinks the agent is, which no outbound PlayerMove will report.
    if (name === 'PositionCorrected') {
      this.takeSelfPosition(body[0], body[1], body[2])
      return
    }
    const slot = ENTITY_STATE_SLOT.get(name)
    if (slot) {
      const id = entityStateId(name, body)
      // A respawn re-states position too, and supersedes any earlier move.
      if (name === 'PlayerRespawned' && Array.isArray(body[0])) {
        if (id === this.selfPlayerId) this.takeSelfPosition(body[0][2], body[0][3], body[0][11])
        else this.playerMoves.delete(id)
      }
      if (this.knowsPlayer(id)) this.entityState.set(`${slot}#${id}`, raw)
      return
    }
    const place = placeKey(name, body)
    if (place) {
      this.places.set(place, raw)
      return
    }
    if (SINGLETON.has(name)) this.singletons.set(name, raw)
  }

  /// A message delivered inside a `WorldUpdate` event. The world view keeps
  /// those for replay; only the agent's own relocations are read here, since
  /// they are what the synthesized self position has to follow.
  observeNested(name, body) {
    if (!Array.isArray(body) || this.selfPlayerId === null) return
    if (MOVE_PLAYER.has(name) && body[0] === this.selfPlayerId) this.takeSelfPosition(body[1], body[2], body[3])
    if (name === 'PlayerRespawned' && Array.isArray(body[0]) && body[0][0] === this.selfPlayerId) {
      this.takeSelfPosition(body[0][2], body[0][3], body[0][11])
    }
  }

  /// A teleport or a correction, never a step: whatever the body was doing
  /// it is standing still at the far end of one.
  takeSelfPosition(position, rotation, floorLevel) {
    if (Array.isArray(position)) this.selfPosition = position
    if (typeof rotation === 'number') this.selfRotation = rotation
    if (typeof floorLevel === 'number') this.selfFloor = floorLevel
    this.selfSprinting = false
  }

  /// The agent's own movement never comes back from the server (see
  /// AgentProxy.onAgentFrame), so it's the one piece of self state that isn't
  /// just "the last raw frame we saw" — synthesized fresh from tracked
  /// position/rotation/floor instead. Used both for that live broadcast and
  /// here, to correct a (re)connecting spectator past the join snapshot's
  /// position, which is only ever current at the moment of joining.
  selfPlayerMovedFrame() {
    if (this.selfPlayerId === null || !this.selfPosition) return null
    return encode({
      PlayerMoved: [
        this.selfPlayerId,
        this.selfPosition.map((n) => new Float(n)),
        new Float(this.selfRotation),
        this.selfFloor,
        this.selfSprinting,
      ],
    })
  }

  /// Order is load-bearing, oldest state first so newer frames correct it:
  ///
  ///   1. join, then the join-time bulk baseline
  ///   2. departures since that baseline — remove what is already gone
  ///   3. introductions we saw ourselves
  ///   4. positions, then per-entity state, for everything introduced above
  ///   5. place- and world-scoped state
  ///
  /// An entity has to be introduced before any frame that repositions or
  /// re-states it, or the client drops a message naming an id it has never
  /// seen — which is why 3 precedes 4 rather than being interleaved.
  ///
  /// `worldReset` is the interest-set snapshot (protocol v80), which carries
  /// everything the per-entity frames below used to; it goes right after the
  /// join, since a reset clears whatever the client drew before it.
  frames(worldReset = null) {
    const out = []
    if (this.join) out.push(this.join)
    if (this.baseline) out.push(this.baseline)
    if (worldReset) out.push(worldReset)

    out.push(...this.playerDrops.values(), ...this.monsterDrops.values(), ...this.groundItemDrops.values())
    out.push(...this.players.values(), ...this.monsters.values(), ...this.groundItems.values())

    const selfMoved = this.selfPlayerMovedFrame()
    if (selfMoved) out.push(selfMoved)
    out.push(...this.playerMoves.values(), ...this.monsterMoves.values())
    out.push(...this.entityState.values())

    out.push(...this.places.values(), ...this.singletons.values())
    return out
  }
}

/// A `WorldUpdate` frame taken apart into byte ranges, so its pieces can be
/// re-emitted without re-encoding them (integral floats would come back as
/// ints, and a spectator reads the same wire format the agent does).
function parseWorldUpdate(frame) {
  try {
    if (frame[0] !== 0x81) return null
    let i = endOf(frame, 1)
    const [count, first] = arrayAt(frame, i)
    if (count !== 8) return null
    i = first
    const fields = []
    for (let k = 0; k < 8; k++) {
      const start = i
      i = endOf(frame, i)
      fields.push([start, i])
    }
    const field = (k) => decode(frame.subarray(fields[k][0], fields[k][1]))
    const events = []
    let [n, at] = arrayAt(frame, fields[7][0])
    for (let k = 0; k < n; k++) {
      const [, inner] = arrayAt(frame, at)
      let j = inner
      const subject = decode(frame.subarray(j, (j = endOf(frame, j))))
      const revision = decode(frame.subarray(j, (j = endOf(frame, j))))
      const change = decode(frame.subarray(j, (j = endOf(frame, j))))
      const [m, messagesAt] = arrayAt(frame, j)
      j = messagesAt
      const messages = []
      for (let q = 0; q < m; q++) {
        const start = j
        j = endOf(frame, j)
        messages.push(frame.subarray(start, j))
      }
      events.push({ subject, revision, change, messages })
      at = endOf(frame, at)
    }
    return {
      epoch: field(0),
      generation: field(1),
      sequence: field(2),
      position: frame.subarray(fields[3][0], fields[3][1]),
      floor: frame.subarray(fields[4][0], fields[4][1]),
      reset: field(5),
      ready: field(6),
      sequenceAt: fields[2],
      events,
    }
  } catch {
    return null
  }
}

/// The agent's interest set, as the server streams it (protocol v80): every
/// nearby entity arrives inside `WorldUpdate` events, subject by subject, and
/// a client accepts those only in sequence from a `reset`. A spectator that
/// attaches after the agent's reset went by would reject everything, so this
/// keeps each subject's snapshot — its Enter messages plus the latest of each
/// Update message kind — to hand a late spectator a reset of its own, and
/// renumbers the live frames that follow so they chain onto it.
class WorldView {
  constructor() {
    this.reset()
  }

  reset() {
    this.epoch = ''
    this.generation = 0
    this.sequence = 0
    this.synchronized = false
    this.position = null
    this.floor = null
    this.ready = false
    this.subjects = new Map()
    this.retiredEpochs = new Set()
  }

  /// Mirrors `WorldView::accept` in shared/src/interest.rs.
  accept(update) {
    const sameEpoch = this.epoch === update.epoch
    if (
      this.retiredEpochs.has(update.epoch) ||
      (sameEpoch &&
        (update.generation < this.generation ||
          (update.generation === this.generation && update.sequence <= this.sequence)))
    )
      return false
    if (update.reset) {
      if (update.sequence !== 1 || (sameEpoch && update.generation <= this.generation)) {
        this.synchronized = false
        return false
      }
      if (this.epoch && !sameEpoch) this.retiredEpochs.add(this.epoch)
      this.epoch = update.epoch
      this.generation = update.generation
      this.sequence = 0
      this.subjects.clear()
      this.synchronized = true
    }
    if (
      !this.synchronized ||
      update.epoch !== this.epoch ||
      update.generation !== this.generation ||
      update.sequence !== this.sequence + 1 ||
      update.events.some((event) => (this.subjects.get(event.subject)?.revision ?? 0) > event.revision)
    ) {
      this.synchronized = false
      return false
    }
    this.sequence = update.sequence
    this.position = update.position
    this.floor = update.floor
    this.ready = update.ready
    for (const event of update.events) {
      if (event.change === 'Leave' || event.change === 'Delete') {
        this.subjects.delete(event.subject)
        continue
      }
      let subject = this.subjects.get(event.subject)
      if (event.change === 'Enter' || !subject) {
        subject = { revision: event.revision, enter: [], updates: new Map() }
        this.subjects.set(event.subject, subject)
      }
      subject.revision = event.revision
      if (event.change === 'Enter') {
        subject.enter = event.messages
        continue
      }
      // Latest of each kind, in order of recency: a death followed by a
      // respawn replays as both, in that order, and ends alive.
      for (const raw of event.messages) {
        const [name] = safeVariant(raw)
        subject.updates.delete(name)
        subject.updates.set(name, raw)
      }
    }
    return true
  }

  /// A `reset` carrying everything in view, numbered as sequence 1 of the
  /// current generation.
  resetFrame() {
    if (!this.synchronized || !this.position) return null
    const parts = [
      Buffer.from([0x81]),
      encode('WorldUpdate'),
      Buffer.from([0x98]),
      encode(this.epoch),
      encode(this.generation),
      encode(1),
      this.position,
      this.floor,
      encode(true),
      encode(this.ready),
      arrayHeader(this.subjects.size),
    ]
    for (const [id, subject] of this.subjects) {
      const messages = [...subject.enter, ...subject.updates.values()]
      parts.push(Buffer.from([0x94]), encode(id), encode(subject.revision), encode('Enter'), arrayHeader(messages.length), ...messages)
    }
    return Buffer.concat(parts)
  }
}

/// The same frame with its sequence field replaced.
function renumbered(frame, update, sequence) {
  const [start, end] = update.sequenceAt
  return Buffer.concat([frame.subarray(0, start), encode(sequence), frame.subarray(end)])
}

/// Mirrors `api_base_url` in agent-client's orchestrator.rs: an explicit port
/// means game port + 1, otherwise the same origin with the path dropped.
/// agent-client derives its REST base from the server URL it was given, so
/// pointing it at the relay means the relay has to answer there too.
function apiBaseUrl(wsUrl) {
  const [scheme, rest] = wsUrl.includes('://') ? wsUrl.split('://') : ['ws', wsUrl]
  const httpScheme = scheme === 'wss' ? 'https' : 'http'
  const authority = rest.split('/')[0]
  const match = authority.match(/^(.*):(\d+)$/)
  return match
    ? `${httpScheme}://${match[1]}:${Number(match[2]) + 1}`
    : `${httpScheme}://${authority}`
}

class AgentProxy {
  constructor(
    onError = () => {},
    onWorn = () => {},
    onSkills = () => {},
    onStats = () => {},
    onTitles = () => {},
    onAbility = () => {},
  ) {
    this.onError = onError
    /// Called with `{ slot: { itemDefId, quantity, enchant } }` whenever the
    /// server restates the agent's inventory. Decoded here rather than in the
    /// renderer because this is the only process that sees the frame.
    this.onWorn = onWorn
    /// Called with the learned skill ids. Same reason as `onWorn`: the skill
    /// frame is owner-private, so agent-client's panel API never republishes
    /// it and the relay is the only place it is seen.
    this.onSkills = onSkills
    /// Called with `{ guard, cha }`, or null when there is no session to read
    /// them from. Same reason as `onWorn`: the frame is owner-private, and
    /// agent-client names it without keeping it.
    this.onStats = onStats
    /// Called with `{ titles, active }` whenever the server restates the
    /// agent's earned titles and its shown pick. Same reason as `onWorn`: the
    /// frame is owner-private, so only the relay sees it.
    this.onTitles = onTitles
    /// Called with the server's answer to `useAbility` — a rejection with its
    /// reason, or the cooldowns that follow a use.
    this.onAbility = onAbility
    this.titles = { titles: [], active: null }
    /// The title worn at entry, until the entry `PlayerTitles` takes it.
    this.joinTitle = null
    this.server = null
    this.apiServer = null
    this.wss = null
    this.port = 0
    this.upstreamUrl = ''
    this.snapshot = new WorldSnapshot()
    this.view = new WorldView()
    this.spectators = new Set()
    /// Per spectator, how its `WorldUpdate` numbering relates to the agent's:
    /// the agent's sequence minus this is the spectator's. Absent until the
    /// spectator has been handed a reset to chain onto.
    this.sequenceBase = new WeakMap()
    this.agentSocket = null
    this.agentUpstream = null
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

    // agent-client reads houses and terrain objects over REST, from a base it
    // derives as our port + 1. Forward those to wherever the real server keeps
    // them, or it walks a world with no buildings in it.
    this.apiServer = http.createServer((req, res) => {
      const target = `${apiBaseUrl(this.upstreamUrl)}${req.url}`
      const headers = { accept: req.headers.accept || '*/*' }
      if (req.headers.authorization) headers.authorization = req.headers.authorization
      fetch(target, { method: req.method, headers, signal: AbortSignal.timeout(20000) })
        .then(async (upstream) => {
          const body = Buffer.from(await upstream.arrayBuffer())
          const type = upstream.headers.get('content-type')
          res.writeHead(upstream.status, type ? { 'content-type': type } : {})
          res.end(body)
        })
        .catch((err) => {
          this.onError(`api ${target}: ${err.message}`)
          res.writeHead(502, { 'content-type': 'text/plain' })
          res.end('relay upstream failed')
        })
    })

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

    // The pair has to be adjacent, so keep drawing until both are free.
    this.port = await listenAdjacentPair(this.server, this.apiServer)
    return this.agentUrl
  }

  /// One agent at a time: agent-client opens a single session, and a second
  /// one would be a stale reconnect racing the live one.
  attachAgent(downstream) {
    if (this.agentSocket) this.agentSocket.close()
    this.agentSocket = downstream
    this.snapshot.reset()
    this.view.reset()
    // A fresh session wears nothing and has trained nothing until the server
    // says otherwise; leaving the last session's gear, skills or gear-fed
    // stats on screen would outlive the character.
    this.onWorn({})
    this.onSkills([])
    this.onStats(null)
    this.titles = { titles: [], active: null }
    this.joinTitle = null
    this.onTitles(this.titles)

    const upstream = new WebSocket(this.upstreamUrl)
    this.agentUpstream = upstream
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

    // Carry the close through instead of hanging up blind. The server's
    // reason is often the only explanation there is — a protocol refusal or a
    // session replacement reads as an unexplained drop without it.
    const closeBoth = (code, reason) => {
      if (this.agentSocket === downstream) this.agentSocket = null
      if (this.agentUpstream === upstream) this.agentUpstream = null
      const [safeCode, safeReason] = relayableClose(code, reason)
      for (const sock of [upstream, downstream]) {
        if (sock.readyState <= WebSocket.OPEN) sock.close(safeCode, safeReason)
      }
    }
    upstream.on('close', closeBoth)
    downstream.on('close', closeBoth)
    upstream.on('error', (err) => {
      this.onError(`upstream ${this.upstreamUrl}: ${err.message}`)
      closeBoth()
    })
    downstream.on('error', (err) => {
      this.onError(`agent socket: ${err.message}`)
      closeBoth()
    })
  }

  attachSpectator(ws) {
    this.spectators.add(ws)
    const reset = this.view.resetFrame()
    if (reset) this.sequenceBase.set(ws, this.view.sequence - 1)
    for (const frame of this.snapshot.frames(reset)) ws.send(frame)
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
    if (name === 'WorldUpdate') {
      this.onWorldUpdate(frame)
      return
    }
    this.snapshot.observe(name, body, frame)
    if (INVENTORY.has(name)) {
      const worn = wornFromInventory(body)
      if (worn) this.onWorn(worn)
    }
    if (name === 'SkillsUpdate') {
      const skills = skillsFromUpdate(body)
      if (skills) this.onSkills(skills)
    }
    if (name === 'AbilityRejected' || name === 'AbilityCooldowns') {
      const reply = abilityFromReply(name, body)
      if (reply) this.onAbility(reply)
    }
    if (name === 'EffectiveStatsUpdated') {
      const stats = statsFromEffective(body)
      if (stats) this.onStats(stats)
    }
    if (name === 'PlayerTitles') {
      const titles = titlesFromUpdate(body)
      if (titles) {
        if (!titles.active && this.joinTitle) titles.active = this.joinTitle
        this.joinTitle = null
        this.titles = titles
        this.onTitles(titles)
      }
    }
    if (name === 'JoinSuccess') this.joinTitle = titleFromJoin(body)
    if (!OWNER_ONLY.has(name)) this.broadcast(frame)
  }

  /// A frame the agent's own view would refuse is not relayed: the agent
  /// answers it with a resync, and the reset that follows supersedes it.
  onWorldUpdate(frame) {
    const update = parseWorldUpdate(frame)
    if (!update || !this.view.accept(update)) return
    for (const event of update.events) {
      for (const raw of event.messages) {
        const [name, body] = safeVariant(raw)
        if (name) this.snapshot.observeNested(name, body)
      }
    }
    for (const ws of this.spectators) {
      if (ws.readyState !== WebSocket.OPEN) continue
      if (update.reset) {
        this.sequenceBase.set(ws, 0)
        ws.send(frame)
        continue
      }
      const base = this.sequenceBase.get(ws)
      if (base === undefined) continue
      ws.send(base === 0 ? frame : renumbered(frame, update, update.sequence - base))
    }
  }

  /// The agent's own movement never comes back from the server, so a
  /// spectator would see a character that never walks. Turn each outbound
  /// PlayerMove into the PlayerMoved its neighbours receive — and record it
  /// on the snapshot, or a spectator that (re)connects later — the header's
  /// reload drops the iframe and builds a new one, and a dropped mirror socket
  /// comes back by itself — gets replayed the position from JoinSuccess, stale
  /// the moment the agent takes its first step.
  onAgentFrame(frame) {
    const [name, body] = safeVariant(frame)
    if (!Array.isArray(body)) return
    if (name === 'PlayerMove') {
      // PlayerMove is [position, rotation, floor_level, append, sprinting]
      // (shared/src/messages.rs) — the sprint flag is what paces the step, so
      // it has to travel with the position it paced.
      const [position, rotation, floorLevel, , sprinting] = body
      if (!Array.isArray(position) || this.snapshot.selfPlayerId === null) return
      this.snapshot.selfPosition = position
      this.snapshot.selfRotation = typeof rotation === 'number' ? rotation : 0
      this.snapshot.selfFloor = typeof floorLevel === 'number' ? floorLevel : this.snapshot.selfFloor
      this.snapshot.selfSprinting = sprinting === true
      if (this.spectators.size === 0) return
      this.broadcast(this.snapshot.selfPlayerMovedFrame())
      return
    }
    if (name === 'MonsterMove') this.onAgentMonsterMove(body)
  }

  /// The agent also runs the AI for every monster the server assigned it
  /// (its own monster_ai.rs), and those moves are echoed back to the owner
  /// no more than the agent's own are — so without this, every monster the
  /// agent drives stands perfectly still in the spectator view while the
  /// ones it does not drive walk around. Same translation as PlayerMove ->
  /// PlayerMoved: the outbound client message plus the owner the server
  /// would have stamped on it on the way out to everyone else.
  ///
  /// Claiming ownership here is safe because a spectator's `ownedByMe()` is
  /// hardcoded false (overlay/.../observerStore.ts) — it will draw the
  /// monster without adopting its brain, which is the whole reason
  /// `MonsterAssigned` is in OWNER_ONLY.
  onAgentMonsterMove(body) {
    const [monsterId, position, rotation, state, targetPosition] = body
    if (typeof monsterId !== 'string' || !Array.isArray(position)) return
    const float = (n) => new Float(typeof n === 'number' ? n : 0)
    const moved = encode({
      MonsterMoved: [
        monsterId,
        position.map(float),
        float(rotation),
        state,
        (Array.isArray(targetPosition) ? targetPosition : position).map(float),
        this.snapshot.selfPlayerId,
      ],
    })
    // Keep it for late joiners too, on the same terms as a server-sent move:
    // only for a monster the spectator has actually been introduced to.
    if (this.snapshot.knownMonsters.has(monsterId)) this.snapshot.monsterMoves.set(monsterId, moved)
    if (this.spectators.size > 0) this.broadcast(moved)
  }

  /// Hand the player's pick of earned title to the server on the agent's own
  /// connection: the renderer has no route to the server but the relay, and
  /// agent-client publishes nothing the player could drive. The frame is the
  /// same `ClientMessage` agent-client itself would send — struct fields in
  /// order, so `SetActiveTitle`'s single Option becomes a one-element array —
  /// and the server answers with a fresh `PlayerTitles`. Returns whether the
  /// frame actually went out; a dead session refuses rather than queuing an
  /// order nobody is there to act on.
  setActiveTitle(title) {
    return this.send({ SetActiveTitle: [title || null] })
  }

  /// Fire an untargeted ability (Guardian Ward) on the agent's connection, the
  /// same way as the title: `UseAbility` is `[ability, monster_id,
  /// target_player_id]`, and the server answers with `AbilityCooldowns` or
  /// `AbilityRejected`, which `onAbility` relays.
  useAbility(ability) {
    return this.send({ UseAbility: [ability, null, null] })
  }

  send(message) {
    const socket = this.agentUpstream
    if (!socket || socket.readyState !== WebSocket.OPEN) return false
    socket.send(encode(message))
    return true
  }

  stop() {
    for (const ws of this.spectators) ws.close()
    this.spectators.clear()
    if (this.agentSocket) this.agentSocket.close()
    this.agentSocket = null
    this.agentUpstream = null
    if (this.wss) this.wss.close()
    if (this.server) this.server.close()
    if (this.apiServer) this.apiServer.close()
    this.server = null
    this.apiServer = null
    this.wss = null
    this.port = 0
    this.snapshot.reset()
  }
}

/// 1005/1006 are "no code was sent" placeholders the spec forbids sending, and
/// anything outside the private range is refused too. Fall back to a normal
/// close so the relay never dies trying to report a death.
function relayableClose(code, reason) {
  const text = reason ? reason.toString() : ''
  const usable = typeof code === 'number' && (code === 1000 || (code >= 3000 && code <= 4999))
  return usable ? [code, text] : [1000, text]
}

/// Bind `ws` to a free port whose neighbour is also free, and `api` to that
/// neighbour. A busy pair is retried rather than fatal.
async function listenAdjacentPair(ws, api, attempts = 20) {
  for (let i = 0; i < attempts; i++) {
    const port = await listen(ws, 0)
    try {
      await listen(api, port + 1)
      return port
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err
      await new Promise((r) => ws.close(r))
    }
  }
  throw new Error('could not find two adjacent free ports for the relay')
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => { server.off('listening', onOk); reject(err) }
    const onOk = () => { server.off('error', onError); resolve(server.address().port) }
    server.once('error', onError)
    server.once('listening', onOk)
    server.listen(port, '127.0.0.1')
  })
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

module.exports = {
  AgentProxy,
  WorldSnapshot,
  WorldView,
  parseWorldUpdate,
  OWNER_ONLY,
  apiBaseUrl,
  wornFromInventory,
  skillsFromUpdate,
  abilityFromReply,
  statsFromEffective,
  titlesFromUpdate,
}
