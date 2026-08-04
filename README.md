# OpenMMO Client

A desktop client for playing [OpenMMO](https://openmmo.to.nexus) manually or
with an LLM at the controls. Pick a server, sign in with Google, choose a
character — it enters play immediately, Automatic if an LLM is configured,
Manual otherwise — then switch between the two live at any time.

```
┌──────────────┬──────────────────────────────┐
│ Equipment    │                              │
│ Bag          │   the game, either your own  │
│ Personality  │   session (Manual) or a live  │
│ Thoughts     │   mirror of the agent's       │
│ Log          │   (Automatic)                 │
├──────────────┴──────────────────────────────┤
│ Dispatch: send word to your character…      │
└─────────────────────────────────────────────┘
```

It drives the official `agent-client` binary for Automatic play and adds what
that binary has no opinion about: connection profiles for more than one
server, encrypted key storage, Google device-flow sign-in as a button instead
of a log line, a live feed of every prompt and reply, and a read-only 3D
mirror of the agent's own session. Manual play skips `agent-client` entirely —
it embeds the real OpenMMO web client under your own Google sign-in.

The customized OpenMMO fork is pinned at `deps/OpenMMO`, so every desktop
commit identifies the exact web client, protocol, and native agent it builds.

## Setup

```bash
git clone --recurse-submodules git@github.com:OpenMMO-Agent-UI/openmmo-client.git
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
tip. `scripts/check-protocol.js` reads `shared/src/lib.rs` from an OpenMMO
checkout, so run it from inside `deps/OpenMMO` (or point it at one):

```bash
cd deps/OpenMMO && node ../scripts/check-protocol.js
# checkout speaks v11; asking wss://openmmo.to.nexus/ws ... accepted
```

or, from the repo root:

```bash
OPENMMO_CHECKOUT="$PWD/deps/OpenMMO" npm run check
```

It names the commit to move `deps/OpenMMO` to if the checkout doesn't match.
Only the handshake is sent, so nothing enters the world.

## How it works

The server permits exactly one controlling session per character, so the two
play modes get there differently:

**Manual play** is a direct connection: the embedded OpenMMO web client signs
in with your own Google session and talks straight to the configured server,
the same as playing in a browser. No relay, no `agent-client`.

**Automatic play** launches `agent-client`, which needs the one session for
itself — so watching it can't mean logging in next to it. Instead
`src/proxy.js` sits on loopback and relays between `agent-client` and the game
server, byte for byte:

```
agent-client <--ws--> proxy (127.0.0.1) <--wss--> openmmo.to.nexus
                        |
                        +--> spectators (/mirror)
```

The server can't tell the agent is behind anything. Being in the middle lets
the proxy tee every server message to a read-only spectator (the desktop
app's own 3D view, joined via `?observe=<url>`) and synthesize the movement
echoes the server never sends back to its own sender — otherwise that view
would show the character, and every monster it owns, standing still. A
snapshot catches up the view when it opens or reloads mid-session. None of
this touches `agent-client/`, which stays at zero modifications; nothing
leaves the machine, since the relay binds `127.0.0.1` only.

Entering play tries Automatic first if an LLM backend is configured and
passes validation; otherwise, or if Automatic fails to start, it falls back
to Manual. A dropped Automatic session retries with backoff rather than
stopping. The mode buttons in the game header switch between the two on
demand.

## Screens

**Server** — pick a connection profile (server URL, terrain origin, Google
client id/secret bundled together, since a server's sign-in token has to
match its own client-id allowlist). The built-in `openmmo.to.nexus` profile
is fixed; custom ones can be created, edited, duplicated, deleted, and
test-connected before use.

**Login** — Google device-flow sign-in for the selected profile. A cached
credential skips straight to Character.

**Character** — two tabs: *Choose your character* (up to 3, server-enforced;
pick one to enter play, or delete it) and *Create a new character* (name,
class, gender — hidden once the account is at the cap). There is no separate
Play step: picking or creating a character enters play immediately.

**Game** — the header shows connection status, vitals, spectator memory
use, a reload button for the 3D view, **Apply & restart** (appears once a
setting changed while the agent is running), the Manual/AI mode switch, and
buttons to change character or server. The left rail opens drawers over the
view:

| Drawer | What it shows |
|---|---|
| Equipment | What's worn, slot by slot — visible only through the relay's view of inventory frames; the agent's own panel API reports the bag but never the gear. |
| Bag | What's carried. |
| Personality | This character's own prompt, layered on the shared rules. Saving while the agent is running restarts it. |
| Thoughts | Every prompt sent and every reply, with timings. |
| Log | The agent process's own stdout/stderr. |

**Dispatch**, docked under the game view, is the one control that reaches a
running agent: type an instruction and it arrives as the character's next
turn, best-effort — see
[ADR 0003](docs/adr/0003-directives-are-best-effort-whispers.md).

**Settings** (opened from the rail or the mode switch) has three tabs: LLM
(backend, model, API key), Automatic play (response-cadence sliders, whether
to keep adventuring while alone), and Advanced (raw intervals, watch port,
log level, concurrency, request timeout).

API keys and connection-profile secrets are encrypted with the OS keychain
(Electron `safeStorage`, with an AES-GCM fallback) and handed to the agent as
environment variables — never written into `config.toml`, so a config pasted
into a bug report carries no credential. `agent-client/data/config.toml` is
regenerated from the panel on every start; an existing hand-written file is
imported once and backed up next to it.

## Choosing a model

`scripts/bench-models.js` scores OpenRouter candidates on whether they keep
track of actual inventory and give up on out-of-range targets, using the
prompt that ships and pricing from the live catalogue:

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

`scripts/build-resources.sh` refuses to build from a checkout that isn't on a
branch carrying the spectator/manual-start integration, then builds the
release agent and web client from `deps/OpenMMO` and hands off to
`scripts/package-resources.sh` (`npm run stage`), which copies them into
`build/resources/` for `electron-builder` to bundle. Both scripts refuse a
binary or client build older than the checkout's newest matching source
commit. Check the protocol first (see above), since the deployed server
isn't always at the checkout's version.

`package-resources.sh` stamps the checkout's `PROTOCOL_VERSION` into
`build-info.json`, which `config.js` reads so the pre-flight session and the
bundled `agent-client` always agree (see
[ADR 0002](docs/adr/0002-protocol-guard-fails-closed.md)). Heavy client
assets (`textures/`, `models/`, `bgm/`, `character_concepts/`, `portraits/`)
are not staged; `server.js` proxies and caches them from the configured
terrain origin at runtime instead.

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

It creates an unsigned draft release with SHA-256 checksums and the full
parent and OpenMMO commit SHAs in the notes. Rerunning the same immutable tag
refreshes that draft. Once published, its artifacts cannot be replaced; make
source fixes under a new patch version.

### Publishing downloads to the wiki

Players download from the public
[wiki repo](https://github.com/OpenMMO-Agent-UI/openmmo-agent-wiki/releases),
not from here — this repository is private, so its release assets return 404
to anonymous visitors. `publish-downloads.yml` mirrors them across.

It fires on `release: published`, not on the tag push: the draft is a human
gate, and publishing it is the act that makes a build public. Manual reruns go
through `workflow_dispatch` with a tag.

The mirror strips the version and protocol out of the filenames, so the wiki's
buttons can point at a URL that never changes:

```
https://github.com/OpenMMO-Agent-UI/openmmo-agent-wiki/releases/latest/download/openmmo-agent-macos-arm64.zip
```

Version and protocol move into the release title and notes. Checksums are
regenerated against the renamed files. Only the newest release is kept — older
ones are deleted after the new one uploads, so a failed run leaves the previous
download working.

Requires a `WIKI_RELEASE_TOKEN` secret: a fine-grained PAT with
**Contents: Read and write** on `openmmo-agent-wiki` only. `github.token`
cannot reach another repository.

Artifacts run 99–129 MB, past GitHub's hard 100 MB per-file limit, so they
cannot be committed to the wiki tree; Git LFS would work but bills for
bandwidth on every download. Release assets have neither problem.

## Known limits

- Changing settings while the agent runs needs **Apply & restart**; the agent
  reads its config once at startup.
- Automatic play's spectator view starts from a snapshot, so anything the
  agent knows about but isn't currently tracking appears as it comes back
  into view.
- Launching from a terminal that is itself an Electron app (VS Code) can leak
  `ELECTRON_RUN_AS_NODE=1` and start the shell as plain Node. Use
  `env -u ELECTRON_RUN_AS_NODE npm start` if `app.whenReady` never resolves.

## Layout

```
src/main.js                Electron main process: IPC, sign-in and play-session orchestration, feed/vitals polling
src/agent.js                resolves and spawns the agent-client binary, streams its logs, detects protocol mismatches
src/config.js                settings <-> data/config.toml, protocol-version resolution, packaged-build seeding
src/characterSession.js      pre-flight sign-in and character CRUD, bypassing agent-client (ADR 0001)
src/connectionProfiles.js    saved server/terrain/Google-client profiles, encrypted secrets and credentials
src/googleAuth.js            client-owned Google device-flow sign-in, shared cache with agent-client
src/llmValidation.js         checks an LLM backend/model/key before Automatic play starts
src/playSession.js           Automatic/Manual state machine: picks a mode, retries drops, switches live
src/proxy.js                 agent <-> game server relay, and the spectator mirror
src/msgpack.js               the wire codec, in the dialect rmp_serde speaks
src/server.js                serves client/dist, proxies /api and any missing/LFS-pointer asset
src/toml.js                  just enough TOML to import an existing config
src/workflow.js              renderer-side state machine driving the Server/Login/Character/Game screens
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
