/// Spectator mode: the page renders an agent-client's mirror stream instead of
/// playing. One character can only hold one session — a second login kicks the
/// first — so watching your own agent means not being a player at all here.
///
/// Decided once from `?observe=<ws url>` and never changes, so every consumer
/// can read it as a constant instead of a store.

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
