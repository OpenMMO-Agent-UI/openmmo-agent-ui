#!/usr/bin/env bash
# Stage build/resources/ from an already-built OpenMMO checkout, for
# electron-builder's `extraResources` to bundle into a packaged app.
#
#   scripts/package-resources.sh <path-to-OpenMMO-checkout>
#
# This does not build anything itself. The checkout must already have been
# through the normal dev setup from the README:
#   ./openmmo-client/scripts/link.sh
#   ./openmmo-client/scripts/patches.sh apply
#   cargo build --release -p agent-client
#   npm --prefix client install && npm --prefix client run build
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

CLIENT_ASSET_EXCLUDES=(--exclude=/textures --exclude=/models --exclude=/bgm --exclude=/character_concepts --exclude=/portraits)

checkout="${1:?usage: package-resources.sh <path-to-OpenMMO-checkout>}"
checkout="$(cd "$checkout" && pwd)"

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="$root/build/resources"

exe="agent-client"
binary="$checkout/target/release/$exe"
if [[ ! -f $binary && -f "$checkout/target/release/$exe.exe" ]]; then
    exe="agent-client.exe"
    binary="$checkout/target/release/$exe"
fi
[[ -f $binary ]] || {
    echo "no agent-client binary at $checkout/target/release/ — run: cargo build --release -p agent-client" >&2
    exit 1
}

dist="$checkout/client/dist"
[[ -f "$dist/index.html" && -d "$dist/assets" ]] || {
    echo "no built client at $dist — run: npm --prefix client install && npm --prefix client run build" >&2
    exit 1
}

# Our client-side behaviour lives in patches/ and overlay/, and none of it
# reaches the app until the client is rebuilt — a dist older than either is a
# client that silently predates it. Found the expensive way: a committed fix
# for a spectator whose character never moved shipped inside an app whose
# bundled client was built hours before the fix existed, and the app was the
# only place anyone was looking.
if [[ -z ${ALLOW_STALE_CLIENT:-} ]]; then
    stale=$(find "$root/patches" "$root/overlay" -type f -newer "$dist/index.html" -print -quit 2>/dev/null || true)
    [[ -z $stale ]] || {
        echo "stale client build: ${stale#"$root/"} is newer than $dist/index.html" >&2
        echo "rebuild it first: npm --prefix client run build (in $checkout), then re-run this" >&2
        echo "or set ALLOW_STALE_CLIENT=1 to stage it anyway" >&2
        exit 1
    }
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

rsync -a "${CLIENT_ASSET_EXCLUDES[@]}" "$dist/" "$out/client/"

# So a stale packaged build fails loudly instead of mysteriously: agent.js
# matches the server's protocol-refusal message and restates it with the
# commit this build was staged from (see config.js's buildInfo()).
commit="$(git -C "$checkout" rev-parse --short HEAD 2>/dev/null || echo unknown)"
protocol="$(grep -o 'PROTOCOL_VERSION: u32 = [0-9]*' "$checkout/shared/src/lib.rs" 2>/dev/null | grep -o '[0-9]*$')"
protocol="${protocol:-null}"
cat > "$out/agent-client/build-info.json" <<JSON
{
  "commit": "$commit",
  "protocolVersion": $protocol
}
JSON

# Following the checkout is right for the *version number*, but the hand-encoded
# message shapes in characterSession.js are a separate question that no version
# can answer — a bump that reorders `Character`'s fields would sail through the
# handshake and quietly mis-read the character list. So say something when the
# checkout has moved past the last version those shapes were read against.
# A warning, not a gate: the whole point of one command is that it completes.
verified="$(grep -o 'SHAPES_VERIFIED_AGAINST = [0-9]*' "$root/src/config.js" | grep -o '[0-9]*$' || true)"
if [[ -n $verified && -n ${protocol//null/} ]] && ((protocol > verified)); then
    echo "note: this checkout speaks v$protocol; characterSession.js's message shapes were" >&2
    echo "      last verified against v$verified. The app will send v$protocol regardless." >&2
    echo "      Worth re-reading ClientInfo/Authenticate/Character in shared/ against" >&2
    echo "      src/characterSession.js, then bumping SHAPES_VERIFIED_AGAINST." >&2
fi

echo "staged $out from $checkout (commit $commit, protocol v$protocol)"
