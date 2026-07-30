#!/usr/bin/env bash
# Build everything a packaged app bundles, from an OpenMMO checkout, then stage
# it. One command, so a release cannot be assembled out of parts nobody
# rebuilt:
#
#   scripts/build-resources.sh <path-to-OpenMMO-checkout>
#
# Steps, in the order the README documents them by hand:
#   link.sh            symlink overlay/ into the upstream tree
#   patches.sh apply   re-apply our edits to upstream's own files (idempotent)
#   cargo build        agent-client, release
#   client build       the web client, with the patches in place
#   package-resources  stage the results into build/resources/
#
# Why this exists as its own script rather than living in
# package-resources.sh: staging is also useful on its own (a checkout someone
# already built by hand, a re-stage after editing only the Electron app), and
# that script's contract — copy what is there, verify it is fresh, touch
# nothing else — is worth keeping separate from the one that mutates the
# checkout.
#
# The failure this is really guarding against: `patches.sh apply` and the
# client build getting separated. Applying the patches leaves the tree dirty,
# so any `git checkout`/`reset` in between silently reverts observer mode, and
# a client rebuilt afterwards is stock upstream — with every overlay file still
# sitting there, symlinked and unreferenced. package-resources.sh's staleness
# guard compares mtimes and cannot see it. Found in a checkout whose staged
# dist had zero observer-mode symbols in it and whose guard passed anyway.
set -euo pipefail

checkout="${1:?usage: build-resources.sh <path-to-OpenMMO-checkout>}"
checkout="$(cd "$checkout" && pwd)"

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Both helper scripts resolve the checkout from OPENMMO_CHECKOUT or from
# wherever git says they are — the latter finds openmmo-client's own repo when
# the two are siblings, not the checkout. Be explicit rather than lucky.
export OPENMMO_CHECKOUT="$checkout"

echo "==> linking overlay into $checkout"
bash "$root/scripts/link.sh"

echo "==> applying patches"
bash "$root/scripts/patches.sh" apply

echo "==> building agent-client (release)"
cargo build --manifest-path "$checkout/Cargo.toml" --release -p agent-client

# `npm install` rather than `ci`: upstream's client is not always shipped with
# a lockfile in sync with its package.json, and a release build failing on that
# is worse than installing what the manifest resolves to.
echo "==> building the web client"
npm --prefix "$checkout/client" install
npm --prefix "$checkout/client" run build

echo "==> staging"
bash "$root/scripts/package-resources.sh" "$checkout"
