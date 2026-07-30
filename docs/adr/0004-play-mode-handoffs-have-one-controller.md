# Play-mode handoffs have exactly one controller

The server permits one controlling session per character. Automatic play uses
`agent-client`; manual play uses the interactive OpenMMO web client. Starting
the target first would briefly create two controllers, while stopping the
source and immediately changing the UI can claim a mode that never became
ready.

The Electron main process therefore owns a play-session coordinator. A switch
stops and cancels the current controller, starts the target, waits for its
readiness signal, and only then commits the visible mode. If the target fails,
it attempts to restore the prior controller. A failed restoration produces an
explicit disconnected state instead of inventing ownership.

Unexpected automatic-play exits retry forever at 2, 5, 10, then 30 seconds.
Choosing manual play, navigating away, or closing the app cancels pending work
and timers. The renderer displays state but cannot create controller overlap.

**Rejected:** keeping both clients connected and merely hiding one. Besides
violating server ownership, stale LLM actions could execute after the player
takes control.
