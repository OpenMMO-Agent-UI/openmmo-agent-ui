#!/usr/bin/env bash
# Build everything a packaged app bundles, from an OpenMMO checkout, then stage
# it. One command, so a release cannot be assembled out of parts nobody
# rebuilt:
#
#   scripts/build-resources.sh [path-to-OpenMMO-checkout]
#
# Steps, in the order the README documents them by hand:
#   cargo build        agent-client, release
#   client build       the web client
#   package-resources  stage the results into build/resources/
#
# What is deliberately *not* a step: putting our edits to upstream's own files
# into the tree. Those are commits on a spectator branch in the checkout now,
# not a patch this script re-applies, so the only thing to do about them is
# check they are there — see the guard below.
#
# Why this exists as its own script rather than living in
# package-resources.sh: staging is also useful on its own (a checkout someone
# already built by hand, a re-stage after editing only the Electron app), and
# that script's contract — copy what is there, verify it is fresh, touch
# nothing else — is worth keeping separate from this one.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
checkout="${1:-"$root/deps/OpenMMO"}"
checkout="$(cd "$checkout" && pwd)"

# Both helper scripts resolve the checkout from OPENMMO_CHECKOUT or from
# wherever git says they are — the latter finds this repo's own root when
# the two are siblings, not the checkout. Be explicit rather than lucky.
export OPENMMO_CHECKOUT="$checkout"

# Is this checkout actually on a branch carrying spectator mode? Nothing here
# can put it there, so the only useful thing is to say so before spending a
# release cargo build and a client build on a tree that will produce a stock
# upstream client.
#
if ! grep -qs 'observerStore' "$checkout/client/src/App.svelte" ||
   ! grep -qs 'manualBootstrap' "$checkout/client/src/App.svelte"; then
    echo "$checkout lacks the required spectator/manual client integration." >&2
    echo "Initialize the pinned dependency first:" >&2
    echo "  git submodule update --init --recursive" >&2
    exit 1
fi

echo "==> building agent-client (release)"
cargo build --manifest-path "$checkout/Cargo.toml" --release -p agent-client

echo "==> building the web client"
npm --prefix "$checkout/client" ci
npm --prefix "$checkout/client" run build

echo "==> staging"
bash "$root/scripts/package-resources.sh" "$checkout"
