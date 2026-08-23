---
name: openmmo-release-sync
description: Fully-unattended flow that syncs deps/OpenMMO (our fork of Julian-adv/OpenMMO) to Julian's latest release, rebases our tweak-agent-client customizations onto it, and cuts a matching openmmo-agent-ui release. Runs on a schedule (launchd, every 8h) — invoke manually only to test the flow or force a run.
---

# OpenMMO release sync

This repo's game client talks to a server that rejects any connection whose
`PROTOCOL_VERSION` doesn't match exactly (see `scripts/check-protocol.js`).
`deps/OpenMMO` is a submodule pointing at `OpenMMO-Agent-UI/OpenMMO`, a fork of
`Julian-adv/OpenMMO`, carrying our customizations on the `tweak-agent-client`
branch. When Julian cuts a new release, our fork and branch need to catch up
or the deployed server and our client eventually speak different protocol
versions.

This skill runs the entire catch-up unattended: no step pauses for approval.
Conflicts during rebase are resolved by your own judgment (see Step 3). The
only thing that can stop the run early is a failed build/test gate — those
are real safety nets, not confirmation checkpoints, and they abort rather
than asking.

Every run ends with exactly one `PushNotification` — success or failure, not
both, and not one per step. If Step 1 finds nothing to do, exit quietly with
no notification (that is the routine case, not news).

## Step 0: orientation

```
cd <repo root>
node scripts/release-sync-check.js
```

This prints JSON: `needsSync`, `hasNewRelease`, `serverAcceptsPin`,
`serverMessage`, `releaseTag`, `releaseSha`, `protocolVersion`, `forkHead`,
`pinnedSha`. It compares Julian's latest
non-draft release against **this repo's current submodule pin**, not
against the fork's master — so a prior run that pushed the fork/branch side
but failed before the main-repo commit still shows `hasNewRelease: true`,
and this run picks up wherever the last one stopped. Steps below are safe to
re-run: pushing an already-pushed ref is a no-op, rebasing an
already-rebased branch is a no-op, and the tag script only bumps `r` when
there's something new to mark.

If `needsSync` is `false`, stop here. No notification.

`needsSync` has two independent reasons, and they need different work:

- **`hasNewRelease: true`** — the normal case. Keep the JSON output around;
  `releaseTag`, `releaseSha` and `protocolVersion` are used throughout the
  rest of this flow, and the steps below run as written.
- **`serverAcceptsPin: false`** — the live server has stopped accepting the
  build we ship, with no release attached to it. This happens when Julian
  redeploys off master: the dungeon layout fingerprint moves without the
  protocol number changing and without a tag, so there is no `releaseTag` to
  sync to and `hasNewRelease` can be `false`. `serverMessage` carries the
  server's own refusal text. Ask which commit to land on instead of guessing:

  ```
  npm run check                 # scripts/check-protocol.js
  ```

  It stamps the layout, classifies the refusal, and names the newest commit
  the server accepts. **Use that commit as `releaseSha` for Steps 1-5** —
  everything else in this flow is unchanged, except that there is no release
  tag, so Step 5's version comes from a patch bump of the current
  `package.json` rather than from `releaseTag`.

  (`serverAcceptsPin: null` means the server could not be reached. That is
  not a reason to sync; if `hasNewRelease` is also false, stop.)

After bumping the pin in Step 5, run `node scripts/record-pin-gate.js` so
`config/release.json` records what the new pin presents at the handshake —
`test/pinGate.test.js` fails the Step 6 gate if you forget, because that
recorded pair is what this five-minute check reads without a submodule.

## Step 1: align the fork's master with the release lineage

The fork's `master` (`OpenMMO-Agent-UI/OpenMMO`) tracks Julian's release
lineage. It may be exactly at the release commit, or it may already be ahead
of that release with later Julian commits that Tony has chosen to keep. Do
not reset it backwards just because it is ahead of the release tag.

```
cd deps/OpenMMO
git fetch origin master
git fetch https://github.com/Julian-adv/OpenMMO.git tag <releaseTag> --no-tags
git tag -d <releaseTag>   # the fetch above still writes a local tag ref; drop it, we don't keep it
git checkout master
git merge-base --is-ancestor FETCH_HEAD origin/master && echo already-at-or-ahead
```

If that check passes, the release commit is already contained in fork
`master`. Leave fork `master` where it is, but **do not build this release
from the ahead tip**. The desktop release must track the official Julian
release tag, so create/reset a local base branch at the release commit and
use that as Step 2's rebase base.

```
git branch -f release-sync-base <releaseSha>
git checkout release-sync-base
```

If the release commit is not contained in `origin/master`, verify the old
fast-forward direction:

```
git merge-base --is-ancestor origin/master FETCH_HEAD && echo can-fast-forward
```

If this second check passes, advance fork `master` to the release commit:

```
git reset --hard <releaseSha>   # the SHA from FETCH_HEAD / the check script's releaseSha
git push origin master
```

Plain `push`, not force — this must always be a fast-forward. If the push is
rejected, someone/something moved the fork's master out from under this run;
abort and notify rather than retrying with force.

If neither ancestry check passes, `master` has diverged from the release
lineage. That's outside this skill's authority to fix — abort the whole run
and notify with what you found, don't force anything onto it.

## Step 2: rebase tweak-agent-client onto the new master

```
git checkout tweak-agent-client   # or: git checkout -B tweak-agent-client origin/tweak-agent-client
git rebase release-sync-base      # use master only when Step 1 actually fast-forwarded master to releaseSha
```

If it completes cleanly, move on to Step 3.

**If it stops on a conflict**, resolve it yourself, per-hunk, using this
policy — favor keeping our customization, *unless* Julian's side already
implements the same thing:

1. `git status` to see conflicted files; `git diff` to see the conflict
   markers in context.
2. For each conflicted file, read enough surrounding code (and, if it
   clarifies intent, the upstream commit that introduced the conflicting
   change — `git log -p master -- <file>`) to judge: does upstream's new
   code already do what our customization was doing? If yes, take
   upstream's side and drop ours (their version now covers it — keeping
   ours too would duplicate or conflict with it going forward). If no —
   upstream changed something unrelated, or removed/altered code near our
   change without actually replacing its behavior — keep our
   customization, re-applied on top of upstream's surrounding change.
3. Edit the file to the resolved state, `git add <file>`.
4. Once every conflicted file in that step is staged, `git rebase --continue`.
5. Repeat for any further conflicting commits in the rebase.

If a conflict is genuinely ambiguous — you cannot tell whether upstream
already covers our customization's intent, even after reading the relevant
history — do not guess. `git rebase --abort` to leave no partial rebase
state behind, then abort this entire skill run and notify with which file
and commit needs a human to look at it.

## Step 3: submodule build+test gate

Still inside `deps/OpenMMO`, on the rebased `tweak-agent-client`:

```
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cd client
npm ci
bash ../tools/fetch-assets.sh client/public/
npm run build:wasm
npm test
npm run check
npm run lint
npm run format:check
cd ..
```

(These mirror `deps/OpenMMO/.github/workflows/ci.yml` exactly — if that
workflow file has changed since this was written, match the current
version of it instead of this list.)

`fetch-assets.sh` downloads the binary client assets that some tests read
directly; they are pinned in `assets.lock` but intentionally not tracked in
git. Run it before `npm test`, otherwise tests that load real `.glb` rigs can
fail with missing files even when the code is fine.

`build:wasm` regenerates `data/monster_attack_clips.json` from monster
`.glb` models — if this checkout is missing LFS model assets, the
generator happily overwrites it with `{}` (a false "no attack clips"
state). Check `git status` after `build:wasm`/`npm test`/`generate:*`
steps in this submodule; if that file shows modified, `git checkout --
data/monster_attack_clips.json` before doing anything else. It's a
build-artifact regeneration side effect, not a real change, and must never
reach a commit.

Any failure in the actual test/lint/fmt/clippy commands above: stop. Do
**not** push `tweak-agent-client` or tag it. `git rebase --abort` is not
needed (rebase already finished; this is a separate, later gate) but do
leave the local branch as-is for inspection — do not reset or discard it.
Send one `PushNotification` naming the failing command and a one-line
reason, then end the run.

If a command fails for a *local environment* reason rather than a code
reason (a missing tool, e.g. `wasm-pack: command not found`, or a missing
Rust target) — that's not a defect in the sync, it's this machine missing
something the flow needs to ever succeed. Install what's missing (see
"Local environment prerequisites" below for what this machine needed the
first time) and retry, rather than treating it as a code-quality abort.

## Step 4: tag and push the submodule

Helper scripts under `scripts/` resolve their own paths from `__dirname`,
not from cwd or `git rev-parse --show-toplevel` — safe to call by absolute
path from anywhere, including from inside this submodule (which is itself
a git repo, so cwd-relative resolution would otherwise silently break).

```
cd deps/OpenMMO   # if not already there
node <repo root>/scripts/release-sync-next-tag.js <protocolVersion>
```

Read the fresh `PROTOCOL_VERSION` from `shared/src/lib.rs` on the rebased
branch (not the value from Step 0's JSON — confirm they match; they should,
since only upstream's release commit sets it, but re-reading here is the
actual source of truth) and pass that to the script above. It prints
`nextTag`.

```
git tag -a <nextTag> -m "Sync to <releaseTag>, protocol v<protocolVersion>"
git push origin tweak-agent-client --force-with-lease
git push origin <nextTag>
```

The branch push must be force (rebase rewrote its history) — use
`--force-with-lease`, not plain `--force`, so a push landing on
`tweak-agent-client` from anywhere else between fetch and push aborts
loudly instead of getting silently overwritten.

## Step 5: bump this repo's pin and version

Back in the repo root:

```
git add deps/OpenMMO
node scripts/release-sync-update-protocols.js <protocolVersion>
git add config/release.json
```

`release-sync-update-protocols.js` is idempotent and only touches the file
when the version is new — this project's `config/release.json` gate
(`verifiedProtocols`) exists to keep unverified protocols out of a release;
this skill's build+test gate in Step 3 is treated as that verification.

Determine the new main-repo version: strip the `agent-client-` prefix off
`releaseTag` (e.g. `agent-client-v0.16.0` → `v0.16.0`, version string
`0.16.0`). This is not an independent version bump — this repo's
version tracks Julian's release number directly.

```
npm version 0.16.0 --no-git-tag-version   # substitute the actual version
git add package.json package-lock.json
```

## Step 6: commit, then the main-repo build+test gate

`npm run validate:pin` (`scripts/release-plan.js`) reads the submodule
pin from **`git ls-tree HEAD`** — the last commit, not the index. It can
only pass after committing, so commit first here, then gate on it:

```
git commit -m "Sync to OpenMMO <releaseTag> (protocol v<protocolVersion>)"
```

```
npm ci
npm run validate:pin
```

`validate:pin` only passes if Step 4 actually pushed the submodule side —
it checks the pinned SHA is reachable from a configured remote ref. If it
fails here, something is wrong with Step 4 (or this step ran without it);
don't paper over it by skipping ahead.

```
npm test
npm --prefix deps/OpenMMO/client run build:wasm
npm --prefix deps/OpenMMO/client test
npm --prefix deps/OpenMMO/client run check
```

(Mirrors `.github/workflows/ci.yml`'s `test` job — match the current
version of that file if it has diverged from this list. Same LFS caveat
as Step 3: revert `deps/OpenMMO/data/monster_attack_clips.json` with
`git -C deps/OpenMMO checkout -- data/monster_attack_clips.json` if
`build:wasm` here dirtied it again.)

Any failure: **undo the commit** — `git reset --soft HEAD~1` — so the
working tree keeps the staged changes for inspection, but master doesn't
carry a commit that never passed its own gate. The submodule side stays
pushed regardless (that's fine — the next run's Step 0 will see the main
repo's pin still behind and retry from here). Don't touch anything under
`deps/OpenMMO`. Send one `PushNotification` naming the failing command,
then end the run.

## Step 7: tag and push the main repo

```
git tag v<version>
git push origin master
git push origin v<version>
```

Use the actual default branch name if it differs from `master` (check
`git branch --show-current` — this repo's default is `master` as of this
writing).

## Step 8: wait for release CI

Pushing the `v*` tag triggers `.github/workflows/release.yml`, which builds
all three platform installers and **publishes the release itself** — there is
nothing left for this step to approve. Publishing is what fires
`publish-downloads.yml`, so the wiki's download link and every installed
client's auto-update feed move in the same run.

This step used to end by promoting a draft. The draft gate is gone on
purpose: the one time it mattered, a protocol-matching build sat unpublished
for a day while the live link served a client the server refused. See
RELEASE.md ("There is deliberately no human gate") for the full account. The
checks that actually protect a release all run *before* the tag is pushed or
inside the job itself — so treat Steps 3 and 6 as the gate, not this one.

```
gh run list --workflow=release.yml --branch=v<version> --limit=1
```

Poll (e.g. `gh run watch <run-id>`, or repeat the list command with a short
sleep) until that run completes.

- **On success**: send one `PushNotification` reporting it (new version,
  protocol version, release URL).
- **On failure**: nothing was published — `gh release create` is the last
  step of the job. Send one `PushNotification` naming which CI job failed and
  a link to the run. Fix forward under a new patch version; `release-plan.js`
  refuses to overwrite a tag that did publish.

`smoke-release.yml` runs after publishing, but only against the **Linux
AppImage**, and only reads back the protocol version. It is not cover for the
other two platforms: v0.33.0 shipped a Windows package whose agent-client and
wasm carried a dungeon layout fingerprint the server refused, passed this
smoke test, and reached users through auto-update. What catches that class of
bug now is `scripts/verify-staged-layout.js`, which runs during staging on the
machine doing the building — i.e. inside each platform's own `package` job.

## Local environment prerequisites

This machine needed the following one-time setup before Step 3 could pass
(as of the first real run, 2026-08-02). If a future run hits the same
missing-tool errors — e.g. on a rebuilt machine — redo these rather than
treating them as a code failure:

- `gh auth login` — Step 8 (and Step 0's release lookup) need `gh`
  authenticated with `repo` + `workflow` scopes.
- `brew install wasm-pack` — `npm run build:wasm` shells out to it.
- Rust here is a plain Homebrew install (no rustup), which has no
  `wasm32-unknown-unknown` target and no supported way to add one. Fix:
  `brew install rustup` (keg-only, installs to
  `/opt/homebrew/opt/rustup/bin` without touching the Homebrew `rustc`
  already on `PATH`), then:
  ```
  export PATH="/opt/homebrew/opt/rustup/bin:$PATH"
  rustup toolchain install stable --profile minimal
  rustup default stable
  rustup target add wasm32-unknown-unknown
  ```
  `scripts/release-sync-cron.sh` prepends that same directory to `PATH` so
  scheduled runs pick up rustup's `cargo`/`rustc` (which have the target)
  ahead of Homebrew's (which don't) — anything invoking cargo/rustc in
  this flow must run with that `PATH` in effect.
- The main repo's own `node_modules` (`npm ci` at the repo root, not just
  inside `deps/OpenMMO/client`) — easy to miss since Steps 3's `npm ci`
  only covers the submodule's client.

## Notes for future edits to this skill

- The three build/test command lists in Steps 3 and 6 are copied from
  `deps/OpenMMO/.github/workflows/ci.yml` and this repo's
  `.github/workflows/ci.yml`. If those workflows change, update this file
  to match — the goal is "what CI actually checks", not "what this file
  says".
- `config/release.json`'s `fallbackProtocol` is set by
  `release-sync-update-protocols.js` to whatever was the newest verified
  protocol before this run. That field is otherwise a human's deliberate
  choice of which older protocol to keep supporting — this skill only ever
  advances it, never removes entries from `verifiedProtocols`.
- Julian's release cadence is roughly daily, and this flow's trigger is
  "there's a release we haven't synced" — not "the protocol version
  changed". Expect roughly-daily runs of the full pipeline, most of which
  will have `protocolVersion` unchanged from the last run (those just bump
  the tag's `r` and cut a same-protocol release).
