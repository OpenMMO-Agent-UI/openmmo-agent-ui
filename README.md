# OpenMMO Client

A desktop client for playing [OpenMMO](https://openmmo.to.nexus) manually or
with an LLM at the controls. Choose a server, sign in, choose a character, then
switch between the hand and robot controls at any time.

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

The customized OpenMMO fork is pinned at `deps/OpenMMO`, so every desktop
commit identifies the exact web client, protocol, and native agent it builds.

## Setup

Clone this repository with its pinned dependency:

```bash
git clone --recurse-submodules git@github.com:Daky/openmmo-client.git
cd openmmo-client
```

Then build and run:

```bash
npm install
npm run build:resources
npm start
```

The build deliberately skips Git LFS payloads; terrain assets stream from the
selected profile's terrain origin and are cached at runtime.

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
- **We see the agent's own outbound moves.** The server never echoes your own
  movement back to you, so a spectator would otherwise watch a character that
  never walks — and since the agent also runs the AI for every monster the
  server assigned it, the same silence applies to those. Each outgoing
  `PlayerMove` becomes the `PlayerMoved` the agent's neighbours receive, and
  each `MonsterMove` the `MonsterMoved`, stamped with the agent as owner. That
  ownership is safe to state because a spectator's `ownedByMe()` is always
  false, so it draws the monster without adopting its brain.

The proxy keeps a snapshot so a spectator that connects late is caught up
before the live stream starts — and reloading the view *is* a late connect, so
whatever the snapshot misses is wrong until a live frame happens to correct it.
`WorldSnapshot` therefore tracks the join frame and the join-time `GameState`
baseline, every entity's latest position (the agent's own included, which the
server never echoes back), health, torch, alive-or-dead, ground items, shop and
dungeon state, gold, inventory and the clock. Monster health is the one thing it
cannot carry: it arrives only inside `MonsterSpawned` and the protocol has no
`MonsterHealthUpdate` to update it afterwards.

Messages that belong to the owning connection (`MonsterAssigned`,
`SpawnMonsterRequest`, auth and character management) are never forwarded: a
spectator that adopted monsters would run a second AI for creatures the agent
already drives.

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
| Settings | A dialog: server, terrain origin, Google sign-in and client id/secret, ports, log level |

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

## Pinned OpenMMO dependency

All spectator and manual web-client customization lives in the public fork.
This repository records one exact commit through the `deps/OpenMMO` submodule;
it does not track a branch tip.

```bash
git submodule update --init --recursive
git -C deps/OpenMMO fetch origin --tags
git -C deps/OpenMMO checkout <FULL_COMPATIBILITY_COMMIT_SHA>
npm run validate:pin
```

Do not use `git submodule update --remote` to prepare a release. The selected
commit must be available from `tpai/OpenMMO`, match the target protocol, and
contain the spectator and manual-start integration. Preserve compatibility
commits with immutable fork tags such as `agent-client/protocol-v11-r1`; the
parent repository still pins their full SHA.

<details>
<summary>Historical overlay design (no longer used)</summary>

Our changes come in two shapes, kept apart on purpose.

**`overlay/` — files that are entirely ours.** They mirror the upstream tree
layout, and `scripts/link.sh` symlinks each into place so cargo and vite find
it. Upstream has no file at those paths, so an update cannot conflict with
them. This is where the bulk of the work lives:

```
overlay/agent-client/data/user_prompt.txt             who the character is
overlay/client/src/lib/stores/observerStore.ts        spectator mode flag
```

**A branch in the game checkout — the upstream files we must reach into.** The
only places an update can conflict, so they are kept as small as possible, and
they live as ordinary commits on a spectator branch in the OpenMMO checkout.

This used to be a `patches/` directory in this repo, re-applied with
`git apply -3`. Two things were wrong with it. Re-applying a patch onto a moved
upstream is exactly the situation that produces conflicts, and `git apply -3` is
a worse tool for it than the rebase git already has. And the file list was a
hardcoded bash array someone had to remember to extend — by the time it was
removed it had already fallen behind the real work, silently dropping the
`ChatPanel.svelte` and `GameHud.svelte` changes from every patch it recorded.

A branch has neither problem: `git rebase` handles a moved upstream with real
conflict resolution and `rerere`, and it cannot lose a file, because nothing
enumerates them.

### Updating the game underneath us

```bash
git fetch origin
git rebase origin/master <your-spectator-branch>
./openmmo-client/scripts/link.sh
```

`link.sh` is idempotent and repoints existing symlinks, so it is safe to re-run
after any rebase. The overlay files stay gitignored in the checkout, which is
what keeps them out of the branch and out of the rebase entirely.

### What the branch changes

`agent-client/` needs no change at all — the relay replaces what would otherwise
be four Rust hooks. The web client needs nine files, +344/−161:

- `vite.config.ts` — `preserveSymlinks`, or the overlay's relative imports break
- `App.svelte` — spectator entry path, and holding the scene back until the
  watched character exists
- `socket.ts` — send-silent in spectator mode, `observe()`
- `messageHandlers.ts` — route the watched agent through remote interpolation
- `monsterManager.ts` — ownership checks go through `ownedByMe()`
- `GameScene.svelte` / `GameScenePlayersLayer.svelte` — no input FSM when observing
- `GameHud.svelte` / `ChatPanel.svelte` — hide the player-action HUD when there is
  no player to act
- `.gitignore` — our symlinks, and the generated config's secret-bearing backup

Run `git diff origin/master...<your-spectator-branch> -- client/` for the current
list rather than trusting this one; the last time it was written down by hand it
went stale without anyone noticing.

</details>

### In-browser agent (withdrawn)

An in-browser agent — the same loop running inside the web client, on your own
key, with no second process — was built and then withdrawn: the client's Google
sign-in needs a `VITE_GOOGLE_CLIENT_ID` this project does not ship, so it could
never be exercised. It lives in the history if it is wanted back.

## Packaging a standalone build

`npm start` needs `npm run build:resources` once. A packaged build ships its
own copy of the binary and web client and writes
its runtime data (`config.toml`, `memory.txt`, the terrain tile cache) under
the OS's app data directory instead of into the bundle, which is read-only
once packaged.

The submodule pin is the only normal build input:

```bash
npm install
npm run dist:mac    # or dist:win / dist:linux
```

`scripts/build-resources.sh` builds the release agent and web client from
`deps/OpenMMO`, then stages them. Staging checks the built bundle for both
spectator and desktop manual-start capabilities.

The binary gets the equivalent check: staging refuses one older than the
checkout's newest `agent-client/src`/`shared/src` commit. `npm run stage` alone
(no cargo build) reusing whatever binary already sits in `target/release/` is
exactly how this goes wrong — confirmed by pointing a real binary at a local
socket and reading the protocol version it actually sent, which did not match
the one the same build's `build-info.json` claimed.

Check the protocol first, though — the deployed server is not always at the
checkout's version, and it refuses anything that is not an exact match:

```bash
npm run check
```

It names the commit to move the checkout to. The packaged app follows whatever
it is built from: `package-resources.sh` stamps the checkout's
`PROTOCOL_VERSION` into `build-info.json` and `config.js` reads it from there,
so the pre-flight session and the bundled `agent-client` always agree
(see [ADR 0002](docs/adr/0002-protocol-guard-fails-closed.md)).

`OPENMMO_CHECKOUT` remains an explicit development escape hatch; CI and normal
local builds intentionally ignore branch tips and use the recorded pin.

`scripts/package-resources.sh` (also runnable on its own as `npm run stage`,
for a checkout you already built by hand) copies the release binary and the
built client into `build/resources/`, which `electron-builder`'s
`extraResources` bundles into the app — except the client's own `textures/`, `models/`,
`bgm/`, `character_concepts/`, and `portraits/`. Those are the same
hundreds of MB the official site already serves, so `server.js` proxies
them from the configured terrain origin at runtime instead of shipping a
copy, caching whatever it fetches to disk (`userData/asset-cache/`) so
only the first time a given texture or model is needed costs the network
round trip. Also staged: only the fixed-content slice of `agent-client/data/`
(prompts, templates, animation timings — not `config.toml`, `memory.txt`, or
the tile cache). The output lands in `out/`, around 130 MB zipped / 300 MB
unpacked — almost all of that Electron itself.

GitHub Actions builds each target on its native runner. All artifacts are
unsigned: macOS Gatekeeper
refuses to open it from a double-click, so right-click → Open once, or run
`xattr -cr "OpenMMO Agent.app"` from a terminal; Windows SmartScreen has an
equivalent "Run anyway" prompt.

### Creating an unsigned release

Only a valid `v<semver>` tag on `master` triggers the release workflow. The tag
supplies the app version; do not edit `package.json` or `build-info.json`.

```bash
git add deps/OpenMMO
git commit -m "chore(deps): pin OpenMMO protocol v11"
git push origin master

git tag v0.15.0
git push origin v0.15.0
```

The workflow validates the pinned protocol and source commits, reruns both
repositories' tests, and builds:

```text
openmmo-agent-v0.15.0-p11-macos-arm64.zip
openmmo-agent-v0.15.0-p11-windows-x64.exe
openmmo-agent-v0.15.0-p11-linux-x64.AppImage
```

It creates an unsigned draft release with checksums and the full parent and
OpenMMO SHAs. Rerunning the same immutable tag refreshes that draft. Once
published, its artifacts cannot be replaced; make source fixes under a new
patch version.

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
deps/OpenMMO/     exact customized OpenMMO dependency
overlay/          desktop-owned prompts and agent data only
scripts/          build-resources.sh, package-resources.sh
```

## License

MIT. OpenMMO itself is a separate project under its own license.
