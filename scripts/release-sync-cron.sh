#!/bin/bash
# Invoked by launchd every 8h (see the plist in this same directory's sibling
# LaunchAgents entry). Not meant to be run by hand except to test the flow —
# for that, just invoke the skill interactively instead: `claude` then
# `/openmmo-release-sync`.
set -euo pipefail

# launchd's environment is minimal (no shell profile sourced) — name every
# directory this flow's tools live in explicitly rather than relying on a
# login shell PATH.
#
# rustup's shims MUST precede Homebrew's own cargo/rustc: rustup is
# installed keg-only (it does not symlink into /opt/homebrew/bin, and does
# not populate ~/.cargo/bin either) specifically so it doesn't clobber the
# Homebrew rust other projects on this machine use — but that also means
# Homebrew's plain rustc, which has no wasm32-unknown-unknown target, would
# otherwise win by coming first. See "Local environment prerequisites" in
# SKILL.md for how the rustup toolchain + target were installed.
export PATH="/opt/homebrew/opt/rustup/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.local/bin"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

SETTINGS="$REPO_ROOT/.claude/skills/openmmo-release-sync/cron-settings.json"

# No --permission-mode flag: the settings file's explicit allow list is
# what makes this headless-safe. Anything the flow tries that falls
# outside that list is deliberately left ungranted (denied or blocked,
# rather than silently bypassed) — if the flow ever needs a tool call this
# list doesn't cover, that should surface as a visible failure to fix, not
# get papered over with a blanket bypass.
claude -p "/openmmo-release-sync" \
  --settings "$SETTINGS"
