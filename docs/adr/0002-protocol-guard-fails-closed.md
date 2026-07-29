# The pre-flight session's protocol guard fails closed

The pre-flight session (ADR 0001) hand-encodes a slice of the wire protocol
in JS. What it sends in `ClientInfo` is `CHARACTER_SESSION_PROTOCOL_VERSION`
(config.js) — a fact about *this JS code*, which struct shapes it knows how
to build — checked against the live server. This is deliberately independent
of whatever `agent-client` binary the user has configured: that binary's own
compatibility is a separate concern, already caught at its own runtime by
`scanForProtocolMismatch` in `agent.js`. An earlier version of this guard
tried to derive "my version" from `settings.binaryPath`/the checkout on disk
instead, and broke the first time it was tested against a real server with
the binary copied outside any checkout (`~/Downloads/agent-client`) — there
was no `shared/src/lib.rs` to read at all, even though the binary itself was
current. A hand-updated constant has no such blind spot.

We could have failed open on a mismatch — skip the character list/select/
delete step and fall back to the plain `characterName` text field, letting
`agent-client` resolve auth and character itself as it does today. We chose
to fail closed instead: if the guard's version is refused, Play stops before
`agent-client` is ever launched, with a message pointing at
`scripts/check-protocol.js`.

Reasoning: if `characterSession.js`'s hardcoded protocol version is refused,
its hand-encoded message shapes are likely stale against whatever the server
now expects — continuing would mean trusting encode/decode logic that may no
longer match reality (a corrupted character list, or a create/delete that
silently does the wrong thing), which is worse than stopping and asking for
an update.
