#!/usr/bin/env bash
# Stage build/resources/ from an already-built OpenMMO checkout, for
# electron-builder's `extraResources` to bundle into a packaged app.
#
#   scripts/package-resources.sh [path-to-OpenMMO-checkout]
#
# This does not build anything itself. The checkout must already be on a branch
# carrying spectator mode, and have been through the normal dev setup from the
# README:
#   cargo build --release -p agent-client
#   npm --prefix client ci && npm --prefix client run build
#
# scripts/build-resources.sh does all of that and then calls this.
#
# Only the fixed-content subset of agent-client/data/ is staged — the rest
# (config.toml, memory.txt, data/cache/*, data/npcs/, data/prompts/) is
# runtime state or server-side-only content, seeded or generated at run time
# instead. See config.js's seedRuntimeData() / writeConfig().
#
# client/dist's own public/ assets (textures, models, bgm, character art —
# the same files the official site already serves, and hundreds of MB) are
# skipped the same way: server.js proxies any missing asset with a real
# extension to the configured terrain origin instead, so the packaged app
# streams them at runtime rather than shipping a copy.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
checkout="${1:-"$root/deps/OpenMMO"}"
checkout="$(cd "$checkout" && pwd)"
out="$root/build/resources"

binary="$(node "$root/scripts/find-agent-binary.js" "$checkout/target/release")" || {
    echo "no agent-client binary at $checkout/target/release/ — run: cargo build --release -p agent-client" >&2
    exit 1
}
exe="$(basename "$binary")"

# This only ever checks the binary *exists*, same as the client build below —
# and unlike the client, nothing here rebuilds it, so a binary that predates a
# protocol bump is staged exactly as readily as a current one. Caught for real:
# staging alone (`npm run stage`, no cargo build) reused a binary compiled
# before a checkout moved to a new PROTOCOL_VERSION, silently paired it with a
# build-info.json stamped from the checkout's *current* shared/src/lib.rs, and
# produced a shipped app whose own build-info claimed the right protocol while
# the binary inside it spoke the old one — confirmed by intercepting its actual
# handshake bytes, not just reading source.
#
# `-src` only: agent-client/CUSTOM_FEATURES.md is a doc file under
# agent-client/, and a commit that only touches it is not a reason to demand a
# rebuild.
newest_src=$(git -C "$checkout" log -1 --format=%ct -- agent-client/src shared/src agent-client/Cargo.toml shared/Cargo.toml 2>/dev/null || echo 0)
binary_built=$(node "$root/scripts/file-mtime.js" "$binary")
if [[ -z ${ALLOW_STALE_CLIENT:-} ]] && ((newest_src > binary_built)); then
    echo "stale agent-client binary: $binary predates the checkout's newest agent-client/shared commit" >&2
    echo "  binary built: $(date -r "$binary_built" 2>/dev/null || echo "$binary_built")" >&2
    echo "  last commit:  $(date -r "$newest_src" 2>/dev/null || echo "$newest_src") ($(git -C "$checkout" log -1 --format='%h %s' -- agent-client/src shared/src))" >&2
    echo "rebuild it: cargo build --release -p agent-client (in $checkout), then re-run this" >&2
    echo "or set ALLOW_STALE_CLIENT=1 to stage it anyway" >&2
    exit 1
fi

dist="$checkout/client/dist"
[[ -f "$dist/index.html" && -d "$dist/assets" ]] || {
    echo "no built client at $dist — run: npm --prefix client install && npm --prefix client run build" >&2
    exit 1
}

# Client customization now lives wholly in the pinned checkout. Committer
# dates rather than a
# branch-switch time, which git does not record: a rebase restamps them to now,
# so moving the spectator branch onto a new upstream reads as "newer than your
# dist" and forces the rebuild it genuinely needs. Caught staging a dist eight
# hours older than the branch it was about to be packaged with — the overlay had
# not been touched since, so comparing against overlay alone passed, and the web
# client sends its own protocol_version(), so that dist would have spoken the
# wrong protocol from inside a bundle stamped with the right one.
if [[ -z ${ALLOW_STALE_CLIENT:-} ]]; then
    client_commit=$(git -C "$checkout" log -1 --format=%ct -- client/ 2>/dev/null || echo 0)
    dist_built=$(node "$root/scripts/file-mtime.js" "$dist/index.html")
    if ((client_commit > dist_built)); then
        echo "stale client build: $dist was built before the checkout's newest client/ commit" >&2
        echo "  dist built:  $(date -r "$dist_built" 2>/dev/null || echo "$dist_built")" >&2
        echo "  last commit: $(date -r "$client_commit" 2>/dev/null || echo "$client_commit") ($(git -C "$checkout" log -1 --format='%h %s' -- client/))" >&2
        echo "rebuild it: npm --prefix client run build (in $checkout), then re-run this" >&2
        echo "or set ALLOW_STALE_CLIENT=1 to stage it anyway" >&2
        exit 1
    fi
fi

rm -rf "$out"
mkdir -p "$out/agent-client/data" "$out/client"

cp "$binary" "$out/agent-client/$exe"
chmod +x "$out/agent-client/$exe"

data="$checkout/agent-client/data"
for entry in system_prompt.txt user_prompts templates animation_durations.json; do
    src="$data/$entry"
    [[ -e $src ]] || { echo "warning: missing $src, skipping" >&2; continue; }
    cp -R "$src" "$out/agent-client/data/$entry"
done

cp -R "$dist/." "$out/client/"
rm -rf \
    "$out/client/textures" \
    "$out/client/models" \
    "$out/client/bgm" \
    "$out/client/character_concepts" \
    "$out/client/portraits"

# The staleness guard above compares mtimes, which cannot see the one failure
# that actually happens: the checkout is on a branch without spectator mode, so
# the client built from it is stock upstream. Every overlay file is still sitting
# there, symlinked and unreferenced, and dist is newer than all of it — so the
# guard passes and the app ships a client that cannot spectate.
#
# So ask the build itself. These two survive minification, unlike the
# identifiers (`isObserver`, `observerStore`) a first attempt looked for and
# found zero of in a dist that turned out to be perfectly good: Svelte keeps
# class names, and our own UI copy is a string literal either way. Either one
# is enough, so editing the wording does not break the build.
if ! grep -rqs -e 'observer-waiting' -e 'Waiting for the agent to enter the world' "$out/client/"; then
    echo "staged client has no observer mode in it. Rebuild the pinned checkout:" >&2
    echo "  scripts/build-resources.sh $checkout" >&2
    exit 1
fi
if ! grep -rqs -e 'Could not enter the game' -e 'Authentication failed' "$out/client/"; then
    echo "staged client has no desktop manual-start contract. Rebuild the pinned checkout:" >&2
    echo "  scripts/build-resources.sh $checkout" >&2
    exit 1
fi

# So a stale packaged build fails loudly instead of mysteriously: agent.js
# matches the server's protocol-refusal message and restates it with the
# commit this build was staged from (see config.js's buildInfo()).
#
# `protocolVersion` is also what the packaged app *sends* in its own handshake
# — config.js's protocolVersion() reads it from here rather than carrying a
# hand-updated constant, so the pre-flight session and the agent-client binary
# we bundle beside it can never disagree about which protocol this build
# speaks. They were staged from one checkout; this is that checkout's number.
checkout_commit="$(git -C "$checkout" rev-parse HEAD 2>/dev/null || echo unknown)"
if [[ -n ${OPENMMO_BUILD_SHA:-} && $OPENMMO_BUILD_SHA != "$checkout_commit" ]]; then
    echo "planned OpenMMO commit $OPENMMO_BUILD_SHA does not match checkout $checkout_commit" >&2
    exit 1
fi
commit="${OPENMMO_BUILD_SHA:-$checkout_commit}"

checkout_protocol="$(grep -o 'PROTOCOL_VERSION: u32 = [0-9]*' "$checkout/shared/src/lib.rs" 2>/dev/null | grep -o '[0-9]*$')"
checkout_protocol="${checkout_protocol:-null}"
if [[ -n ${OPENMMO_PROTOCOL_VERSION:-} && $OPENMMO_PROTOCOL_VERSION != "$checkout_protocol" ]]; then
    echo "planned protocol v$OPENMMO_PROTOCOL_VERSION does not match checkout v$checkout_protocol" >&2
    exit 1
fi
protocol="${OPENMMO_PROTOCOL_VERSION:-$checkout_protocol}"
parent_commit="${DESKTOP_BUILD_SHA:-$(git -C "$root" rev-parse HEAD 2>/dev/null || echo unknown)}"
cat > "$out/agent-client/build-info.json" <<JSON
{
  "parentCommit": "$parent_commit",
  "openmmoCommit": "$commit",
  "protocolVersion": $protocol
}
JSON

# CI and tag builds gate this version against config/release.json before
# packaging. Staging remains usable with an explicit development checkout, but
# the stamp above always records exactly what that checkout speaks.

echo "staged $out from $checkout (commit $commit, protocol v$protocol)"
