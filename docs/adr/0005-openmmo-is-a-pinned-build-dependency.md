# OpenMMO is a pinned build dependency

Desktop releases need customized spectator and manual-start behavior from the
OpenMMO web client plus a matching native `agent-client`. An external checkout
and locally injected overlay made the release source depend on unrecorded
machine state.

The public `tpai/OpenMMO` fork is now an HTTPS Git submodule at
`deps/OpenMMO`. Its exact commit is the only normal build input. All customized
web-client sources live in that fork; this repository retains only
desktop-owned prompts and templates. Resource staging verifies both spectator
and manual capabilities and stamps the pinned commit and protocol.

The submodule does not track a branch. A maintainer checks out a full commit
SHA and commits the resulting gitlink. Older protocols use integration-complete
compatibility commits in the fork, retained by immutable tags such as
`agent-client/protocol-v10-r1`; the parent still records the SHA rather than
resolving that tag during a build.

Only a `v<semver>` tag on `master` starts a release. The tag is the packaged app
version, so a release does not require a committed `package.json` bump. A
release gate verifies the tag, parent ancestry, remote-reachable submodule pin,
explicitly supported protocol, and both repositories' tests before the native
matrix starts.

GitHub Actions checks out submodules without Git LFS and produces unsigned
macOS arm64, Windows x64, and Linux x64 artifacts whose names include the app
and protocol versions. The draft release records the full parent and OpenMMO
SHAs and includes SHA-256 checksums. A rerun may refresh an existing draft but
never overwrite a published release; publication remains manual.

**Rejected:** selecting a branch-tip checkout through `OPENMMO_CHECKOUT` for
normal builds. A branch name does not make old and new desktop commits
reproducible together.
