# Releasing

Maintainer-facing: choosing the default model, pinning the OpenMMO
dependency, and cutting a release. Players and contributors building from
source don't need anything on this page — see the main [README](README.md).

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
commit must be available from `OpenMMO-Agent-UI/OpenMMO`, match the target protocol, and
contain the spectator and manual-start integration. Preserve compatibility
commits with immutable fork tags such as `agent-client/protocol-v11-r1`; the
parent repository still pins their full SHA.

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
commit. Check the protocol first (see the main README), since the deployed
server isn't always at the checkout's version.

`package-resources.sh` stamps the checkout's `PROTOCOL_VERSION` into
`build-info.json`, which `runtimeEnv.js` reads so the pre-flight session and
the bundled `agent-client` always agree. Heavy client assets (`textures/`,
`models/`, `bgm/`, `character_concepts/`, `portraits/`) are not staged;
`server.js` proxies and caches them from the configured terrain origin at
runtime instead.

GitHub Actions builds each target on its native runner. The macOS artifact is
signed with a Developer ID certificate — shallow, single top-level `codesign`
pass, not deep-signed and not notarized — so Gatekeeper still refuses to open
it from a double-click; right-click → Open once, or run
`xattr -cr "OpenMMO Agent.app"`. Windows and Linux artifacts are unsigned;
Windows SmartScreen has an equivalent "Run anyway" prompt.

### Creating a release

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

It creates a draft release with SHA-256 checksums and the full
parent and OpenMMO commit SHAs in the notes. Rerunning the same immutable tag
refreshes that draft. Once published, its artifacts cannot be replaced; make
source fixes under a new patch version.

### Publishing downloads to the wiki

Players download from the public
[wiki repo](https://github.com/OpenMMO-Agent-UI/openmmo-agent-wiki/releases),
not from here — its download links stay fixed across versions (see below),
which this repository's own versioned release pages can't offer.
`publish-downloads.yml` mirrors them across.

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
