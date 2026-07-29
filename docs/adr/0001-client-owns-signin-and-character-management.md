# The Electron app owns Google sign-in and character management, not agent-client

`agent-client` currently owns the entire Google device-flow sign-in and,
immediately upon authenticating, auto-resolves and enters a character with no
pause point — `characters.first()`-after-name-match, auto-create if absent,
auto-delete only under NPC-token auth (never under Google auth). There is no
way to show a human a character list and let them pick, delete, or create
without either patching `agent-client`'s orchestrator or duplicating a slice
of its auth/character wire protocol elsewhere.

We chose to duplicate: the Electron app performs the Google device flow
itself (writing the same credential cache file `agent-client` already reads,
in the same format), then opens a **pre-flight session** — a direct,
throwaway WebSocket connection to the game server, reusing the existing
msgpack codec (`src/msgpack.js`) — to list, create, and delete characters.
`agent-client` is launched only afterward, with `character_name` set to an
exact, already-existing match, so its own auto-create/auto-delete logic never
activates.

This keeps `agent-client` at zero source modifications (no new file under
`patches/` to keep in sync across upstream rebuilds), at the cost of the
Electron app now hand-encoding a small, deliberately narrow corner of the wire
protocol (`ClientInfo`, `Authenticate`, `AuthSuccess`, `CreateCharacter`,
`DeleteCharacter`, `CharacterCreated/Deleted/Error`) — chosen because this
corner is far more stable than the gameplay protocol (movement, combat,
inventory), which the client never touches.

**Considered and rejected:** patching `agent-client`'s orchestrator to add a
pause-and-ask point after auth. Rejected because it reintroduces exactly the
merge-conflict-on-upstream-update risk the project's `patches/` strategy
exists to minimize, for a feature (character selection) that turned out to
be achievable without it.
