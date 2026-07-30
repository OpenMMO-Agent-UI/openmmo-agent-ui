# OpenMMO Client

The Electron desktop client that drives the official `agent-client` binary and
adds what it has no opinion about: sign-in, character management, a spectator
view, and a way for a human to steer an otherwise-autonomous LLM character.

## Language

**Pre-flight session**:
A short-lived WebSocket connection the Electron app opens directly to the game
server — bypassing `agent-client` entirely — to sign in, list, create, and
delete characters before `agent-client` is ever launched. It owns all
character CRUD; `agent-client` is only ever handed one already-resolved,
already-existing character name to enter.
_Avoid_: character session, management session, auth session

**Connection profile**:
The bundle of `server`, `terrain`, `googleClientId`, and `googleClientSecret`
selected before sign-in on the server screen. Bundled because they aren't
independently swappable: the game server validates a sign-in token's Google
client ID against its own allowlist, so pointing at a different server
generally means supplying a matching client ID/secret pair for it, not just
changing the server URL alone.
_Avoid_: connection settings

**Play session**:
The lifetime of exactly one controlling client for one selected character.
Its controller is either the AI `agent-client` or the interactive manual web
client. A mode handoff does not commit until the replacement controller is
ready, and controllers never overlap.
_Avoid_: agent session (manual play has no agent), game process

**Automatic play**:
The AI-controlled play mode. It retries unexpected failures indefinitely and
uses the one global LLM configuration.
_Avoid_: auto-run, bot mode

**Manual play**:
The human-controlled embedded OpenMMO client, bootstrapped with the desktop
app's selected profile, credential, and stable character ID.
_Avoid_: player mode, browser mode

**Protocol guard**:
The check, made when opening a pre-flight session, that
`CHARACTER_SESSION_PROTOCOL_VERSION` (a hand-updated constant in config.js —
what `characterSession.js`'s hand-encoded messages were written against) is
still accepted by the live server. A mismatch fails closed — sign-in stops
before `agent-client` is ever launched. Deliberately independent of whatever
`agent-client` binary is configured; that binary's own compatibility is
checked separately, at its own runtime, by `agent.js`'s
`scanForProtocolMismatch`.
_Avoid_: version check (too generic — this is specifically the pre-flight
gate, not agent-client's own runtime mismatch detection); deriving this
number from the configured checkout/binary path (tried, and broken by a
binary copied outside any checkout — see ADR 0002)

**Directive**:
Free-text instruction a player sends to steer their own LLM-driven character
mid-session, without restarting `agent-client`. Delivered as a
relay-synthesized `WhisperMessage` (see below), which already carries
`Urgent` scheduling priority in `agent-client`'s own turn scheduler — the
highest tier that exists. Compliance is best-effort: nothing forces the LLM
to obey a directive, so the UI must show the directive and the agent's next
action side by side, prominently, so the player can see whether it landed
and re-issue if not.
_Avoid_: priority prompt, override, command (this project's "command" already
means something else in the wire protocol)

**Directive whisper**:
The specific mechanism behind a Directive: the relay forges a
`ServerMessage::WhisperMessage` frame toward `agent-client`, as if the game
server itself had sent it, addressed to the agent's own character. It exists
only because a whisper already gets `Urgent` priority and unconditional
prompt inclusion in `agent-client` — not because whispering is semantically
what's happening. Always sent with `from: "Director"` — a fixed sentinel, not
the player's Google display name — so the shipped default prompt can name it
literally ("a whisper from Director is your player's direct order").
_Avoid_: injected message, fake whisper
