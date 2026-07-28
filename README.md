# OpenMMO Client

A desktop client for playing [OpenMMO](https://openmmo.to.nexus) with an LLM at
the controls. Pick a model, write who your character is, press start — and
watch it live in the real 3D game client while it plays.

```
┌──────────────┬──────────────────────────────┐
│ Character    │                              │
│ Model        │   the game, rendered from    │
│ Prompt       │   the agent's own session    │
│ Thoughts     │                              │
│ Connection   │                              │
│ Log          │                              │
└──────────────┴──────────────────────────────┘
```

It drives the official `agent-client` binary and adds what that binary has no
opinion about: a settings panel, encrypted key storage, Google device-flow
sign-in surfaced as a button instead of a log line, a live feed of every prompt
and reply — and a 3D spectator view of your own character.

This repo holds **only our additions**. Upstream OpenMMO stays untouched, so it
can be updated underneath us — see [Staying rebaseable](#staying-rebaseable).

## Setup

Clone the game, then clone this repo inside it as `openmmo-client/`:

```bash
git clone https://github.com/Julian-adv/OpenMMO.git
cd OpenMMO
git lfs pull                                   # models, textures, music
git clone git@github.com:Daky/openmmo-client.git

./openmmo-client/scripts/link.sh               # our sources into the game tree
./openmmo-client/scripts/patches.sh apply      # our hooks into upstream's files
```

Then build and run:

```bash
cargo build --release -p agent-client
npm --prefix client install && npm --prefix client run build
npm --prefix openmmo-client install
npm --prefix openmmo-client start
```

In the window: put your character's name under **Character**, an OpenRouter key
under **Model**, then press **Start** and complete the Google sign-in from the
banner. The character must already exist on your account, or it is created for
you.

### Requirements

- Rust — a current stable, plus `wasm32-unknown-unknown` and `wasm-pack` for
  the client's wasm build
- Node 20+
- `git-lfs`. Skipping it is survivable: the local server notices the pointer
  files and fetches those assets from the official site instead.

### Protocol versions

The server checks the wire protocol **exactly** and refuses anything else, so
your checkout has to match what is deployed — which is not always upstream's
tip. If start fails with `Protocol vN required, you sent vM`, move the game
checkout to the commit whose `shared/src/lib.rs` has `PROTOCOL_VERSION = N`.

## Why it needs a relay

One character can hold only one session — a second login kicks the first — so
the window cannot simply log in next to the agent.

Instead we sit in the middle. `src/proxy.js` listens on loopback and relays
between agent-client and the game server, byte for byte:

```
agent-client <--ws--> proxy (127.0.0.1) <--wss--> openmmo.to.nexus
                        |
                        +--> spectators (/mirror)
```

The server cannot tell the agent is behind anything — the same frames, in the
same order. Being in the middle buys two things:

- **Every server message can be teed to spectators**, in the wire format the
  web client already speaks. It joins with `?observe=<url>` and runs in
  spectator mode: no input, no sends, no monster ownership.
- **We see the agent's own outbound moves.** The server never echoes your
  movement back to you, so a spectator would otherwise watch a character that
  never walks. Each outgoing `PlayerMove` becomes the `PlayerMoved` the agent's
  neighbours receive.

The proxy keeps a small snapshot — last `JoinSuccess`, live players and
monsters, gold, inventory, clock — so a spectator that connects late is caught
up before the live stream starts. Messages that belong to the owning connection
(`MonsterAssigned`, `SpawnMonsterRequest`, auth and character management) are
never forwarded: a spectator that adopted monsters would run a second AI for
creatures the agent already drives.

Doing this in the proxy rather than inside agent-client is what keeps
`agent-client/` at **zero modifications**.

Nothing leaves the machine. The relay binds 127.0.0.1 only, and the client
refuses any observe target that is not loopback.

## What the panel controls

| Tab | What it does |
|---|---|
| Character | Name, class, gender, how often the agent thinks |
| Model | Backend (Codex / Claude CLI / OpenRouter / any OpenAI-compatible endpoint), model id, API key |
| Prompt | `agent-client/data/user_prompt.txt` — who the character is |
| Thoughts | Every prompt sent and every reply, with timings |
| Connection | Server, terrain origin, Google sign-in, ports, binary location |
| Log | The agent process's own stdout/stderr |

API keys are encrypted with the OS keychain (Electron `safeStorage`) and handed
to the agent as environment variables — never written into `config.toml`, so a
config pasted into a bug report carries no credential.

`agent-client/data/config.toml` is generated from the panel on every start. An
existing file is imported once (so a hand-written `client_secret` survives) and
backed up next to it.

## In-browser agent mode

The same idea also runs inside the web client itself, with no agent-client and
no second process: a panel in the corner of the game, your key in your browser,
your character. `overlay/client/src/lib/agent/` builds the world state from what
the client already knows, asks the model, and dispatches the reply through the
very controls a mouse click uses — so pathfinding, chasing and range checks
stay in one place and the agent can do nothing a player could not.

Closing the tab stops it, which is the honest difference from the desktop
agent: one plays while you watch, the other plays while the page is open.

## Staying rebaseable

Our changes come in two shapes, kept apart on purpose.

**`overlay/` — files that are entirely ours.** They mirror the upstream tree
layout, and `scripts/link.sh` symlinks each into place so cargo and vite find
it. Upstream has no file at those paths, so an update cannot conflict with
them. This is where the bulk of the work lives:

```
overlay/client/src/lib/stores/observerStore.ts        spectator mode flag
overlay/client/src/lib/agent/                         in-browser agent loop
overlay/client/src/lib/components/AgentPanel.svelte   its UI
```

**`patches/` — the few upstream files we must reach into.** The only places an
update can conflict, so they are kept as small as possible:

```bash
./openmmo-client/scripts/patches.sh list      # which upstream files we touch
./openmmo-client/scripts/patches.sh extract   # working tree -> patches/
./openmmo-client/scripts/patches.sh apply     # patches/ -> working tree
```

### Updating the game underneath us

```bash
git checkout -- $(./openmmo-client/scripts/patches.sh list)   # drop our hooks
git fetch upstream && git merge --ff-only upstream/master     # take the update
./openmmo-client/scripts/link.sh
./openmmo-client/scripts/patches.sh apply                     # put them back
```

If `apply` reports a conflict, resolve it in the file and re-record the result
with `patches.sh extract`. This has survived a 16-commit jump that reworked the
fishing system and the movement FSM without a single conflict — but the day it
does not, that is the loop.

### What the patch does

`agent-client/` needs no patch at all — the relay replaces what would otherwise
be four Rust hooks. The web client needs seven, ~140 lines:

- `vite.config.ts` — `preserveSymlinks`, or the overlay's relative imports break
- `App.svelte` — spectator entry path, agent panel mount
- `socket.ts` — send-silent in spectator mode, `observe()`
- `messageHandlers.ts` — route the watched agent through remote interpolation
- `monsterManager.ts` — ownership checks go through `ownedByMe()`
- `GameScene.svelte` / `GameScenePlayersLayer.svelte` — no input FSM when observing
- `.gitignore` — our symlinks, and the generated config's secret-bearing backup

## Known limits

- Changing settings while the agent runs needs **Apply & restart**; the agent
  reads its config once at startup.
- The spectator view starts from the snapshot, so anything the agent knows
  about but is not currently tracking appears as it comes back into view.
- Launching from a terminal that is itself an Electron app (VS Code) can leak
  `ELECTRON_RUN_AS_NODE=1` and start the shell as plain Node. Use
  `env -u ELECTRON_RUN_AS_NODE npm start` if `app.whenReady` comes back
  undefined.

## Layout

```
src/main.js       process lifecycle, IPC, feed polling, spectator view
src/agent.js      spawns agent-client, streams logs, spots the device code
src/config.js     settings <-> data/config.toml, validation
src/proxy.js      agent <-> game server relay, and the spectator mirror
src/msgpack.js    the wire codec, in the dialect rmp_serde speaks
src/server.js     serves client/dist, proxies /api and LFS-pointer assets
src/toml.js       just enough TOML to import an existing config
src/renderer/     the panel (plain HTML/CSS/JS, no build step)
overlay/          our source, symlinked into the game tree
patches/          our edits to the game's own files
scripts/          link.sh, patches.sh
```

## License

MIT. OpenMMO itself is a separate project under its own license.
