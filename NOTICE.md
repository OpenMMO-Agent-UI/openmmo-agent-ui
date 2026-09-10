# Licensing notice

**This project does not currently have a licence, and that is unresolved
rather than deliberate.** Until it is settled, treat this repository as "all
rights reserved": you can read it, but no licence to use, modify or
redistribute it is granted here.

## Why it is unresolved

This repository is a desktop wrapper. It is not self-contained: what it builds
and ships bundles code from two different sources under two licences that do
not compose.

| Part | Origin | Licence |
| --- | --- | --- |
| `src/`, `scripts/`, `test/`, `config/`, `assets/`, `overlay/` | this repository | intended MIT, see below |
| `deps/OpenMMO` — the `agent-client` binary and the web client staged into every installer by `scripts/package-resources.sh` | [Julian-adv/OpenMMO](https://github.com/Julian-adv/OpenMMO), via our fork | **PolyForm Noncommercial 1.0.0** |

PolyForm Noncommercial permits *any noncommercial purpose* and nothing beyond
it. MIT permits commercial use. A release built from this repository contains
both, so labelling the whole thing MIT would grant something this project is
not in a position to grant.

`package.json` did carry `"license": "MIT"` — a claim about the published
package, i.e. about the thing that bundles upstream's binary. That has been
changed to point at this file, which removes an incorrect assertion without
substituting a new one.

## What still has to be decided by a human

None of these is a code change; each is a call for the maintainers, and the
third involves upstream:

1. **Licence our own code explicitly** — MIT is the stated intent and is fine
   for `src/` on its own, but it needs to be stated in a way that cannot be
   read as covering the bundled upstream binary.
2. **State the distribution terms** — the installers we publish are a
   combined work. Whatever licence covers our source, the *release artifacts*
   inherit PolyForm Noncommercial's restriction.
3. **Talk to Julian** if commercial use is ever wanted, since only the upstream
   copyright holder can relax PolyForm Noncommercial.

## Not affected by this

The audit that surfaced this found no credential anywhere in the repository or
its history. Two credentials are embedded on purpose — the Google device-flow
`client_secret` in `src/settingsStore.js` and the Aptabase app key in
`src/telemetry.js` — and both already ship inside `resources/app.asar` in every
installer, so neither is exposed by this repository being public. Google
documents installed-app client secrets as non-confidential; Aptabase app keys
are client-side ingestion keys meant to be embedded.
