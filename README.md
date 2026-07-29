# OpenMMO Client

A desktop client for playing [OpenMMO](https://openmmo.to.nexus) with an LLM at
the controls. Pick a model, write who your character is, press **Play** — and
watch it live in the real 3D game client while it plays, sending it word when
you want something done.

```
┌──────────────┬──────────────────────────────┐
│ Thoughts     │                              │
│ Log          │   the game, rendered from    │
│ Personality  │   the agent's own session    │
│ Bag          │                              │
├──────────────┴──────────────────────────────┤
│ Dispatch: send word to your character…      │
└─────────────────────────────────────────────┘
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

In the window: point it at the `agent-client` binary if it isn't found
automatically, sign in with Google, then choose an existing character or
create one — up to 3 per account — and press **Play**.

### Requirements

- Rust — a current stable, plus `wasm32-unknown-unknown` and `wasm-pack` for
  the client's wasm build
- Node 20+
- `git-lfs`. Skipping it is survivable: the local server notices the pointer
  files and fetches those assets from the official site instead.

### Protocol versions

The server checks the wire protocol **exactly** and refuses anything else, so
your checkout has to match what is deployed — which is not always upstream's
tip. It has been both ahead of and behind this repo within a single day.

Ask before you start, and it will name the commit to land on:

```bash
node openmmo-client/scripts/check-protocol.js
# checkout speaks v9; asking wss://openmmo.to.nexus/ws ... accepted
```

Only the handshake is sent, so nothing enters the world. If start fails anyway,
the app raises the same answer in its error bar rather than leaving it in the
log.

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

Two screens. You set the run up before pressing **Play**, and watch it after.

Before — tabs on the character screen:

| Tab | What it does |
|---|---|
| Choose your character | The account's characters (3 max). Pick one to play, or delete one. Already have one? It is selected for you and **Play** is ready. |
| Create a new character | Name, class, gender. Stats are rolled and accepted for you |
| LLM & behavior settings | Backend (Codex / Claude CLI / OpenRouter / any OpenAI-compatible endpoint), model id, API key, and how often the agent thinks |
| Advanced connection settings | Opens the same settings dialog as the rail's Settings icon |

After — the rail down the left of the game screen:

| Icon | What it opens |
|---|---|
| Thoughts | Every prompt sent and every reply, with timings |
| Log | The agent process's own stdout/stderr |
| Personality | `data/npcs/<character>/instance.txt` — how *this* character plays, on top of the shared rules. Saving restarts the agent so it takes effect |
| Bag | What the character is carrying, one line per item |
| Settings | A dialog: server, terrain origin, Google sign-in and client id/secret, ports, log level, binary location |

**Dispatch**, docked under the game view, is the one control that reaches a
running agent: type an instruction and it arrives as the character's next turn.
Best-effort by design — see [ADR 0003](docs/adr/0003-directives-are-best-effort-whispers.md).

API keys are encrypted with the OS keychain (Electron `safeStorage`) and handed
to the agent as environment variables — never written into `config.toml`, so a
config pasted into a bug report carries no credential.

`agent-client/data/config.toml` is generated from the panel on every start. An
existing file is imported once (so a hand-written `client_secret` survives) and
backed up next to it.

## Choosing a model

Price alone picks badly here, and so does latency alone. The turn is a
structured world state in and a small JSON action list out — a job small models
can do, *if* they hold two things the prompt spells out: what is actually in
the bag, and that `attack` gives up past 20 metres. The cheap end of the
catalogue answers in perfectly valid JSON and still invents inventory to sell,
or charges a monster forty metres off. Both burn a turn exactly like a timeout
does.

`scripts/bench-models.js` scores candidates on those decisions rather than on
schema alone, using the prompt that actually ships and pricing from the live
catalogue:

```bash
OPENROUTER_API_KEY=sk-or-... node openmmo-client/scripts/bench-models.js
```

A run at the time of writing, three attempts per scenario, cost projected over
an eight-hour night at one turn per 8 seconds:

| model | p50 | inventory | distance | $/8h |
|---|---|---|---|---|
| `qwen/qwen3.7-flash` | 0.7s | 3/3 | 3/3 | $0.60 |
| `openai/gpt-oss-20b` | 0.5s | 3/3 | 3/3 | $0.86 |
| `anthropic/claude-haiku-4.5` | 1.5s | 3/3 | 3/3 | $14.34 |
| `mistralai/mistral-nemo` | 0.3s | 0/3 | 0/3 | $0.23 |
| `inclusionai/ling-2.6-flash` | 0.7s | 0/3 | 1/3 | $0.14 |

The default is `qwen/qwen3.7-flash`: it keeps both rules, answers in well under
a second, and costs a fiftieth of what a frontier model does — which is what
buys the 8-second cadence the game wants, since monsters move while you think.

One trap worth naming: `openai/gpt-oss-20b:free` answered in **51 seconds** and
timed out repeatedly, while the same model on paid routing answers in 0.5s. A
`:free` suffix measures the queue, not the model.

## Staying rebaseable

Our changes come in two shapes, kept apart on purpose.

**`overlay/` — files that are entirely ours.** They mirror the upstream tree
layout, and `scripts/link.sh` symlinks each into place so cargo and vite find
it. Upstream has no file at those paths, so an update cannot conflict with
them. This is where the bulk of the work lives:

```
overlay/agent-client/data/user_prompt.txt             who the character is
overlay/client/src/lib/stores/observerStore.ts        spectator mode flag
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
be four Rust hooks. The web client needs seven, ~150 lines:

- `vite.config.ts` — `preserveSymlinks`, or the overlay's relative imports break
- `App.svelte` — spectator entry path, and holding the scene back until the
  watched character exists
- `socket.ts` — send-silent in spectator mode, `observe()`
- `messageHandlers.ts` — route the watched agent through remote interpolation
- `monsterManager.ts` — ownership checks go through `ownedByMe()`
- `GameScene.svelte` / `GameScenePlayersLayer.svelte` — no input FSM when observing
- `graphicsSettings.ts` — a spectator's frame budget: watching is not playing
- `.gitignore` — our symlinks, and the generated config's secret-bearing backup

### In-browser agent (withdrawn)

An in-browser agent — the same loop running inside the web client, on your own
key, with no second process — was built and then withdrawn: the client's Google
sign-in needs a `VITE_GOOGLE_CLIENT_ID` this project does not ship, so it could
never be exercised. It lives in the history if it is wanted back.

## Packaging a standalone build

`npm start` needs the dev setup above — a built `agent-client` binary and a
built `client/dist`, `link.sh` and `patches.sh` already applied to whatever
OpenMMO checkout you're using. A packaged build needs none of that at
runtime: it ships its own copy of the binary and the web client, and writes
its runtime data (`config.toml`, `memory.txt`, the terrain tile cache) under
the OS's app data directory instead of into the bundle, which is read-only
once packaged.

Building one still starts from a normal dev checkout with `agent-client` and
`client/dist` already built (see Setup), then stages and packages it:

```bash
npm install
OPENMMO_CHECKOUT=/path/to/OpenMMO npm run dist:mac    # or dist:win / dist:linux
```

`OPENMMO_CHECKOUT` doesn't need to be nested inside this repo — `link.sh`,
`patches.sh`, and this staging step all resolve the checkout from it (or,
if it's unset, from `git rev-parse --show-toplevel`, so running them from
inside the checkout works too), so a sibling directory is just as valid as
the nested layout in Setup.

`scripts/package-resources.sh` copies the release binary and the built
client into `build/resources/`, which `electron-builder`'s `extraResources`
bundles into the app — except the client's own `textures/`, `models/`,
`bgm/`, `character_concepts/`, and `portraits/`. Those are the same
hundreds of MB the official site already serves, so `server.js` proxies
them from the configured terrain origin at runtime instead of shipping a
copy, caching whatever it fetches to disk (`userData/asset-cache/`) so
only the first time a given texture or model is needed costs the network
round trip. Also staged: only the fixed-content slice of `agent-client/data/`
(prompts, templates, animation timings — not `config.toml`, `memory.txt`, or
the tile cache). The output lands in `out/`, around 130 MB zipped / 300 MB
unpacked — almost all of that Electron itself.

Only `dist:mac` is verified — built and run on Apple Silicon. Both it and
the untested `dist:win` / `dist:linux` (each needs its own native build
machine for `agent-client`) produce an unsigned app: macOS Gatekeeper
refuses to open it from a double-click, so right-click → Open once, or run
`xattr -cr "OpenMMO Agent.app"` from a terminal; Windows SmartScreen has an
equivalent "Run anyway" prompt.

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
