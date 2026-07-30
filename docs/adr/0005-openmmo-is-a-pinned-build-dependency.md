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

GitHub Actions checks out submodules without Git LFS, builds on each native
target, and produces unsigned macOS arm64, Windows x64, and Linux x64
artifacts. Tags create a draft release with SHA-256 checksums; publication
remains a manual decision.

**Rejected:** selecting a branch-tip checkout through `OPENMMO_CHECKOUT` for
normal builds. A branch name does not make old and new desktop commits
reproducible together.
