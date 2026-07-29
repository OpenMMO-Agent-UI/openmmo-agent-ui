#!/usr/bin/env bash
# Symlink every overlay file into the upstream tree where its build expects it.
#
# Our own source lives in openmmo-client/overlay/ so a rebase onto upstream
# never touches it, but cargo and vite only look inside their own crates. A
# symlink satisfies both: one file, two paths, no copy to drift out of sync.
set -euo pipefail

# Two different roots, found two different ways — conflating them into one
# `../..` from this script only worked when openmmo-client happens to be
# cloned *inside* the OpenMMO checkout (the README's documented layout).
# Checked out as siblings instead, that guess silently lands under the home
# directory instead of the checkout — found by actually running this on
# such a layout, where it created `~/agent-client` and `~/client` instead of
# `~/OpenMMO/agent-client` and `~/OpenMMO/client`.
self_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
overlay="$self_root/overlay"
root="${OPENMMO_CHECKOUT:-$(git rev-parse --show-toplevel 2>/dev/null)}"
[[ -n $root ]] || { echo "Run this from inside the OpenMMO checkout, or set OPENMMO_CHECKOUT" >&2; exit 1; }

[[ -d $overlay ]] || { echo "no overlay at $overlay" >&2; exit 1; }

linked=0
while IFS= read -r src; do
    rel="${src#"$overlay"/}"
    dest="$root/$rel"
    mkdir -p "$(dirname "$dest")"

    if [[ -L $dest ]]; then
        # Already ours; repoint in case the overlay moved.
        ln -sfn "$src" "$dest"
    elif [[ -e $dest ]]; then
        echo "refusing to replace real file: $rel" >&2
        exit 1
    else
        ln -s "$src" "$dest"
    fi
    linked=$((linked + 1))
done < <(find "$overlay" -type f)

echo "linked $linked overlay file(s) into the upstream tree"
