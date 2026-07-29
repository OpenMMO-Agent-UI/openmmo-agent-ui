#!/usr/bin/env bash
# Extract or apply the edits we make to upstream's own files.
#
#   patches.sh extract [base-ref]   regenerate patches/ from the working tree
#   patches.sh apply                re-apply them onto a fresh upstream tree
#   patches.sh list                 show which upstream files we touch
#
# Overlay files (our own new source) are not patches — see link.sh. Only the
# handful of upstream files we have to reach into live here, because those are
# the only ones a rebase can conflict on.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
patches="$root/openmmo-client/patches"

# Every upstream file we modify, grouped by the patch it belongs to.
# agent-client is untouched: the spectator feed comes from src/proxy.js,
# which sits between it and the game server. Kept as an empty group so adding
# a Rust hook later is a one-line change here.
AGENT_FILES=()
CLIENT_FILES=(
    .gitignore
    client/vite.config.ts
    client/src/App.svelte
    client/src/lib/components/GameScene.svelte
    client/src/lib/components/game-scene/GameScenePlayersLayer.svelte
    client/src/lib/managers/monsterManager.ts
    client/src/lib/network/messageHandlers.ts
    client/src/lib/network/socket.ts
)

cmd="${1:-}"
case "$cmd" in
extract)
    base="${2:-HEAD}"
    mkdir -p "$patches"
    cd "$root"
    git diff "$base" -- "${CLIENT_FILES[@]}" > "$patches/0002-client-observer-mode.patch"
    for f in "$patches"/*.patch; do
        if [[ -s $f ]]; then
            echo "wrote $(basename "$f") ($(grep -c '^+' "$f") added lines)"
        else
            echo "warning: $(basename "$f") is empty — wrong base ref?" >&2
        fi
    done
    ;;
apply)
    cd "$root"
    for f in "$patches"/*.patch; do
        [[ -s $f ]] || continue
        # -3 leaves conflict markers instead of refusing outright, which is
        # what you want when upstream moved the code we hook into.
        if git apply -3 "$f"; then
            echo "applied $(basename "$f")"
        else
            echo "CONFLICT in $(basename "$f") — resolve, then run 'patches.sh extract'" >&2
            exit 1
        fi
    done
    ;;
list)
    printf '%s\n' ${AGENT_FILES[@]+"${AGENT_FILES[@]}"} "${CLIENT_FILES[@]}"
    ;;
*)
    sed -n '2,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
