/// Walks the watched character around what stands in its way.
///
/// The mirror hands the spectator positions, not routes: each `PlayerMoved` is
/// where the agent had reached, and drawing a straight line between two of
/// them is only right when nothing is in between. agent-client routes around
/// the geometry it knows about, but its idea of the world is not this client's
/// — houses, props, furniture and dungeon walls are registered here, from
/// terrain the spectator streamed itself — so a leg that clips a wall arrives
/// as "be over there" and the character used to walk through it.
///
/// So a blocked leg is re-routed with the client's own A* (`findPath`, the one
/// click-to-move uses) and handed to `remotePlayerManager` one waypoint at a
/// time, the way PlayerControl's movement substrate does for the local player.
/// A clear leg is left exactly as it was: the blocked test is a cell lookup,
/// the pathfind only happens when it says something is there.

import { passability_is_movement_blocked } from '../wasm/onlinerpg_shared'
import { findPath } from './pathfinding'

export interface Leg {
  x: number
  y: number
  z: number
}

/// Waypoints still to walk, per player, the one being walked now already
/// handed to the manager. Only ever holds the watched character.
const routes = new Map<number, Leg[]>()

export function clearRoute(playerId: number): void {
  routes.delete(playerId)
}

/// The leg to walk now for a character told to be at `to`.
///
/// Returns `to` unchanged when the straight line is clear, when the world has
/// no passability loaded there yet, or when A* finds nothing — the last case
/// beelining exactly as `routeFirstLeg` does upstream, because refusing to
/// move at all would strand the view further from the truth than cutting a
/// corner does.
export function routeObserved(
  playerId: number,
  from: Leg,
  to: Leg,
  floorLevel: number
): Leg {
  routes.delete(playerId)

  let blocked = false
  try {
    blocked = passability_is_movement_blocked(
      from.x,
      from.z,
      to.x,
      to.z,
      floorLevel,
      to.y
    )
  } catch {
    // Passability for this region may not be registered yet; a straight line
    // is the only honest answer until it is.
    return to
  }
  if (!blocked) return to

  const path = findPath(from.x, from.z, floorLevel, to.x, to.z, floorLevel)
  const legs: Leg[] = (path.waypoints ?? []).map((w) => ({
    x: w.x,
    // The manager resamples ground height every frame (entityGroundY), so the
    // target's own Y is a good enough seed for an intermediate waypoint.
    y: to.y,
    z: w.z,
  }))
  if (legs.length === 0) return to

  if (legs.length > 1) routes.set(playerId, legs.slice(1))
  return legs[0]
}

/// The next waypoint of a route in progress, or null when there is none left.
/// Called on arrival, so the polyline is walked leg by leg.
export function nextLeg(playerId: number): Leg | null {
  const legs = routes.get(playerId)
  if (!legs || legs.length === 0) {
    routes.delete(playerId)
    return null
  }
  const leg = legs.shift() as Leg
  if (legs.length === 0) routes.delete(playerId)
  return leg
}
