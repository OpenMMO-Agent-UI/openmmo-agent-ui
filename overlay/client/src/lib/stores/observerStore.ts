/// Spectator mode: the page renders an agent-client's mirror stream instead of
/// playing. One character can only hold one session — a second login kicks the
/// first — so watching your own agent means not being a player at all here.
///
/// Kept free of manager and store imports (`world-wrap` is a leaf of
/// constants): `graphicsSettings` reads `isObserver` during module init, and a
/// cycle back through it would evaluate presets before they exist.
///
/// Decided once from `?observe=<ws url>` and never changes, so every consumer
/// can read it as a constant instead of a store.

import { shortestWrappedDeltaX } from '../terrain/world-wrap'

function readObserveParam(): string | null {
  if (typeof window === 'undefined') return null
  const raw = new URLSearchParams(window.location.search).get('observe')
  if (!raw) return null
  // Loopback only: the mirror is an unauthenticated stream of one player's
  // whole world view, and pointing this at a remote host would be a way to
  // ask a stranger's machine for it.
  try {
    const url = new URL(raw)
    const local = ['127.0.0.1', 'localhost', '[::1]', '::1']
    if (!/^wss?:$/.test(url.protocol) || !local.includes(url.hostname)) {
      console.warn('Ignoring non-loopback observe target:', raw)
      return null
    }
    return url.toString()
  } catch {
    return null
  }
}

export const observerUrl = readObserveParam()

export const isObserver = observerUrl !== null

/// The observed agent's player id, set from the mirror's JoinSuccess. Its own
/// movement is relayed like any other player's, so it is animated through
/// `remotePlayerManager` rather than the local movement FSM.
let observedId: number | null = null

export function setObservedPlayerId(id: number): void {
  observedId = id
}

export function observedPlayerId(): number | null {
  return observedId
}

/// Far enough that walking there is the wrong answer. `getMovementMode` calls
/// anything over 8 units a full run, so that is the widest gap the
/// interpolator can still present as ordinary locomotion — past it the
/// character is not walking, it is chasing a position it fell behind.
const SNAP_DISTANCE = 8

/// Whether the relayed position is a step to walk or a desync to jump to.
///
/// The watched character is animated as a remote player, which means walking
/// toward each position at 3 units a second. That is right for a step and
/// wrong for a gap: a floor change, a scroll of return, a reconnect's
/// catch-up frame or a path leg the relay saw and we did not all arrive as one
/// large jump, and walking it off leaves the view trailing the agent for as
/// long as it takes — sometimes forever, since the next frame moves the target
/// again. Beyond `SNAP_DISTANCE` the position is taken as authoritative
/// instead, which is what a monster does with every `MonsterMoved` and what
/// the local player does with every `PositionCorrected`.
///
/// X uses the wrapped delta, so crossing the world seam counts as the short
/// step it is rather than a jump across the map.
export function farEnoughToSnap(
  from: { x: number; y: number; z: number },
  to: { x: number; y: number; z: number }
): boolean {
  const dx = shortestWrappedDeltaX(from.x, to.x)
  const dz = to.z - from.z
  return dx * dx + dz * dz > SNAP_DISTANCE * SNAP_DISTANCE
}

/// Whether this client drives the entity: never in spectator mode. The agent
/// owns the monsters it was assigned, and a spectator that adopted them would
/// run a second AI sending moves for the same creatures.
export function ownedByMe(
  ownerId: number | undefined | null,
  myPlayerId: number | undefined | null
): boolean {
  if (isObserver) return false
  return ownerId != null && ownerId === myPlayerId
}
