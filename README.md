# OpenMMO Client

A desktop client for playing [OpenMMO](https://openmmo.to.nexus) manually or
with an LLM at the controls. Choose a server, sign in, choose a character,
then switch between the hand and robot controls at any time.

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
sign-in surfaced as a button instead of a log line, a live feed of every
prompt and reply, and a 3D spectator view of your own character.

The customized OpenMMO fork is pinned at `deps/OpenMMO`, so every desktop
commit identifies the exact web client, protocol, and native agent it builds.

## Setup

```bash
git clone --recurse-submodules git@github.com:Daky/openmmo-client.git
cd openmmo-client
npm install
npm run build:resources
npm start
```

The build deliberately skips Git LFS payloads; terrain assets stream from the
selected profile's terrain origin and are cached at runtime.

### Requirements

- Rust — a current stable, plus `wasm32-unknown-unknown` and `wasm-pack` for
  the client's wasm build
- Node 24+
- `git-lfs`. Skipping it is survivable: the local server notices the pointer
  files and fetches those assets from the official site instead.

### Protocol versions

The server checks the wire protocol **exactly** and refuses anything else, so
your checkout has to match what is deployed — which is not always upstream's
tip. Ask before you start:

```bash
node scripts/check-protocol.js
# checkout speaks v11; asking wss://openmmo.to.nexus/ws ... accepted
```

It names the commit to move `deps/OpenMMO` to if the checkout doesn't match.
Only the handshake is sent, so nothing enters the world.

## How it works

One character can hold only one session — a second login kicks the first —
so a spectator window can't just log in next to the agent. Instead
`src/proxy.js` sits on loopback and relays between `agent-client` and the
game server, byte for byte:

```
agent-client <--ws--> proxy (127.0.0.1) <--wss--> openmmo.to.nexus
                        |
                        +--> spectators (/mirror)
```

The server can't tell the agent is behind anything. Being in the middle lets
the proxy tee every server message to spectators (joined via `?observe=<url>`,
read-only) and synthesize the movement echoes the server never sends back to
its own sender — otherwise a spectator would watch a character, and every
monster it owns, stand still. A snapshot catches up spectators that join or
reload late. None of this touches `agent-client/`, which stays at zero
modifications; nothing leaves the machine, since the relay binds
`127.0.0.1` only.

## What the panel controls

Two screens: set the run up, then press **Play** and watch it.

Before — tabs on the character screen:

| Tab | What it does |
|---|---|
| Choose your character | The account's characters (3 max). Pick one to play, or delete one. |
| Create a new character | Name, class, gender. Stats are rolled and accepted for you. |
| LLM & behavior settings | Backend (Codex / Claude CLI / OpenRouter / any OpenAI-compatible endpoint), model id, API key, think interval. |
| Advanced connection settings | Server, terrain origin, Google sign-in, ports, log level. |

After — the rail down the left of the game screen:

| Icon | What it opens |
|---|---|
| Thoughts | Every prompt sent and every reply, with timings. |
| Log | The agent process's own stdout/stderr. |
| Personality | `data/npcs/<character>/instance.txt`. Saving restarts the agent. |
| Bag | What the character is carrying. |
| Settings | Same dialog as Advanced connection settings. |

**Dispatch**, under the game view, is the one control that reaches a running
agent: type an instruction and it arrives as the character's next turn,
best-effort — see [ADR 0003](docs/adr/0003-directives-are-best-effort-whispers.md).

API keys are encrypted with the OS keychain (Electron `safeStorage`) and
handed to the agent as environment variables, never written into
`config.toml`. `agent-client/data/config.toml` is regenerated from the panel
on every start; an existing file is imported once and backed up.

## Choosing a model

`scripts/bench-models.js` scores candidates on whether they keep track of
actual inventory and give up on out-of-range targets, using the prompt that
ships and pricing from the live OpenRouter catalogue:

```bash
OPENROUTER_API_KEY=sk-or-... node scripts/bench-models.js
```

| model | p50 | inventory | distance | $/8h |
|---|---|---|---|---|
| `qwen/qwen3.7-flash` | 0.7s | 3/3 | 3/3 | $0.60 |
| `openai/gpt-oss-20b` | 0.5s | 3/3 | 3/3 | $0.86 |
| `anthropic/claude-haiku-4.5` | 1.5s | 3/3 | 3/3 | $14.34 |
| `mistralai/mistral-nemo` | 0.3s | 0/3 | 0/3 | $0.23 |
| `inclusionai/ling-2.6-flash` | 0.7s | 0/3 | 1/3 | $0.14 |

The default is `qwen/qwen3.7-flash`: it keeps both rules, answers in well
under a second, and costs a fraction of a frontier model — which is what
buys the 8-second turn cadence the game wants. Avoid `:free`-suffixed
routing; it measures queue time, not the model (`openai/gpt-oss-20b:free`
timed out at 51s where paid routing answers in 0.5s).

## Pinned OpenMMO dependency

All spectator and manual web-client customization lives in the public fork.
This repository records one exact commit through the `deps/OpenMMO`
submodule; it does not track a branch tip.

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
parent repository still pins their full SHA. See
[ADR 0005](docs/adr/0005-openmmo-is-a-pinned-build-dependency.md).

## Packaging a standalone build

`npm start` needs `npm run build:resources` once. A packaged build ships its
own copy of the binary and web client, and writes its runtime data
(`config.toml`, `memory.txt`, the terrain tile cache) under the OS's app data
directory instead of into the read-only bundle.

```bash
npm install
npm run dist:mac    # or dist:win / dist:linux
```

`scripts/build-resources.sh` builds the release agent and web client from
`deps/OpenMMO`, then `scripts/package-resources.sh` (`npm run stage`) copies
them into `build/resources/`, which `electron-builder` bundles. Both steps
refuse a binary or client build older than the checkout's newest matching
source commit — check the protocol first (`npm run check`), since the
deployed server isn't always at the checkout's version.

`package-resources.sh` stamps the checkout's `PROTOCOL_VERSION` into
`build-info.json`, which `config.js` reads so the pre-flight session and the
bundled `agent-client` always agree (see
[ADR 0002](docs/adr/0002-protocol-guard-fails-closed.md)). Heavy client
assets (`textures/`, `models/`, `bgm/`, `character_concepts/`, `portraits/`)
are not staged; `server.js` proxies and caches them from the configured
terrain origin at runtime instead. Output lands in `out/`, around 130 MB
zipped / 300 MB unpacked.

GitHub Actions builds each target on its native runner. All artifacts are
unsigned: macOS Gatekeeper refuses to open one from a double-click, so
right-click → Open once, or run `xattr -cr "OpenMMO Agent.app"`; Windows
SmartScreen has an equivalent "Run anyway" prompt.

### Creating an unsigned release

Only a valid `v<semver>` tag on `master` triggers the release workflow. The
tag supplies the app version; do not edit `package.json` or `build-info.json`.

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
- The spectator view starts from a snapshot, so anything the agent knows
  about but isn't currently tracking appears as it comes back into view.
- Launching from a terminal that is itself an Electron app (VS Code) can leak
  `ELECTRON_RUN_AS_NODE=1` and start the shell as plain Node. Use
  `env -u ELECTRON_RUN_AS_NODE npm start` if `app.whenReady` never resolves.

## Layout

```
src/main.js                 process lifecycle, IPC, feed polling, spectator view
src/agent.js                spawns agent-client, streams logs, spots the device code
src/config.js                settings <-> data/config.toml, validation
src/characterSession.js      pre-flight sign-in and character CRUD (ADR 0001)
src/connectionProfiles.js    saved server/terrain/Google-client bundles
src/googleAuth.js            client-owned Google device-flow sign-in
src/llmValidation.js         checks an LLM backend/model/key before Play
src/playSession.js           starts, stops, and hands off between AI and manual play
src/proxy.js                 agent <-> game server relay, and the spectator mirror
src/msgpack.js               the wire codec, in the dialect rmp_serde speaks
src/server.js                serves client/dist, proxies /api and LFS-pointer assets
src/toml.js                  just enough TOML to import an existing config
src/workflow.js              renderer-side state machine driving the panel's screens
src/preload.js               contextBridge surface exposed to the renderer
src/renderer/                the panel (plain HTML/CSS/JS, no build step)
deps/OpenMMO/                pinned, customized OpenMMO dependency
overlay/                     desktop-owned prompts and agent data only
scripts/                     protocol checks, benchmarking, build/release helpers
docs/adr/                    architecture decision records
docs/specs/                  feature specs
test/                        node:test suites, run via `npm test`
```

## License

MIT. OpenMMO itself is a separate project under its own license.
