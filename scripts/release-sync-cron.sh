#!/bin/bash
# Invoked by launchd every 8h (see the plist in this same directory's sibling
# LaunchAgents entry). Not meant to be run by hand except to test the flow —
# for that, just invoke the skill interactively instead: `claude` then
# `/openmmo-release-sync`.
set -euo pipefail

# launchd's environment is minimal (no shell profile sourced) — name every
# directory this flow's tools live in explicitly rather than relying on a
# login shell PATH.
export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.local/bin:$HOME/.cargo/bin"

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
