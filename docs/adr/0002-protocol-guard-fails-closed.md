# The pre-flight session's protocol guard fails closed

The pre-flight session (ADR 0001) hand-encodes a slice of the wire protocol
in JS. What it sends in `ClientInfo` is whatever `protocolVersion()`
(config.js) reports, checked against the live server.

That number originally came from a hand-updated constant. An earlier attempt
to derive it had been reverted: it read the version out of
`settings.binaryPath`/the checkout on disk, and broke the first time it was
tested against a real server with the binary copied outside any checkout
(`~/Downloads/agent-client`) — there was no `shared/src/lib.rs` to read at
all, even though the binary itself was current.

It is derived again now, from two sources that cannot land in that state:
`build-info.json`, stamped at stage time by `scripts/package-resources.sh`
from the checkout it had in hand, and — in dev only — the checkout itself.
Neither is a user-chosen path, and both fall through to
`SHAPES_VERIFIED_AGAINST` instead of guessing. The reason for going back is
that the independence the constant bought turned out to be the wrong
property: the packaged app ships the `agent-client` binary *and* the web
client staged from one checkout, so the pre-flight and the agent can only be
right or wrong together. A constant lagging that bundle by one commit meant
the pre-flight was refused while the agent beside it would have connected
fine — a failure invented entirely by the guard.

A binary the user points at by hand (`settings.binaryPath`, no longer
reachable from the UI) remains a separate concern, caught at its own runtime
by `scanForProtocolMismatch` in `agent.js`.

We could have failed open on a mismatch — skip the character list/select/
delete step and fall back to the plain `characterName` text field, letting
`agent-client` resolve auth and character itself as it does today. We chose
to fail closed instead: if the guard's version is refused, Play stops before
`agent-client` is ever launched, with a message pointing at
`scripts/check-protocol.js`.

Reasoning: if the version we send is refused, `characterSession.js`'s
hand-encoded message shapes are likely stale against whatever the server now
expects — continuing would mean trusting encode/decode logic that may no
longer match reality (a corrupted character list, or a create/delete that
silently does the wrong thing), which is worse than stopping and asking for
an update.

Following the checkout does not answer that second question, and no version
number could: a bump that reorders `Character`'s fields sails through the
handshake and then quietly mis-reads the character list. `SHAPES_VERIFIED_AGAINST`
records the last version those shapes were actually read against, and
`package-resources.sh` warns when the checkout has moved past it. A warning
rather than a gate — the refusal above is the real guard, and a packaging
command that stops on every upstream protocol bump would not be one anyone
runs.
