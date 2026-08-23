'use strict'

/// Records what the current submodule pin will present at the handshake —
/// its protocol number and its dungeon layout fingerprint — into
/// config/release.json.
///
///   node scripts/record-pin-gate.js
///
/// Both are derivable from deps/OpenMMO, so this is duplicated state and
/// would normally not be worth keeping. It earns its place by being readable
/// *without* the submodule: release-sync.yml's every-five-minutes gate
/// deliberately does not clone deps/OpenMMO, and asking the live server
/// whether it still accepts what we ship is exactly the check that was
/// missing when a redeploy moved the generator and locked out every client.
///
/// test/pinGate.test.js fails the build when these drift from the pin, so
/// the duplication cannot go stale unnoticed — it can only be forgotten
/// loudly.

const fs = require('node:fs')
const path = require('node:path')

const { layoutVersion } = require('./layout-version.js')

const ROOT = path.resolve(__dirname, '..')
const CONFIG = path.join(ROOT, 'config', 'release.json')
const CHECKOUT = path.join(ROOT, 'deps', 'OpenMMO')

/// What the pinned checkout speaks, or null when the submodule is not
/// checked out (a bare clone of this repo, CI jobs that skip it).
function pinGate(checkout = CHECKOUT) {
  const lib = path.join(checkout, 'shared', 'src', 'lib.rs')
  if (!fs.existsSync(lib)) return null
  const match = fs.readFileSync(lib, 'utf8').match(/PROTOCOL_VERSION: u32 = (\d+)/)
  if (!match) throw new Error(`no PROTOCOL_VERSION in ${lib}`)
  return { pinnedProtocol: Number(match[1]), pinnedLayout: layoutVersion(checkout) }
}

function record() {
  const gate = pinGate()
  if (!gate) throw new Error(`deps/OpenMMO is not checked out — run: git submodule update --init`)
  const config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'))
  const next = { ...config, ...gate }
  fs.writeFileSync(CONFIG, `${JSON.stringify(next, null, 2)}\n`)
  return gate
}

module.exports = { pinGate, CONFIG, CHECKOUT }

if (require.main === module) {
  const gate = record()
  process.stdout.write(`recorded protocol v${gate.pinnedProtocol}, layout ${gate.pinnedLayout}\n`)
}
