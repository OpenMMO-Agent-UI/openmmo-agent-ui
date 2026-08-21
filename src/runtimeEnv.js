'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { app } = require('electron')

const { syncSeed } = require('./seedSync')

const releaseConfig = require('../config/release.json')

/// The OpenMMO checkout `agentDir()`/`clientDist()` (server.js) resolve
/// `agent-client/` and `client/` against in dev. `OPENMMO_CHECKOUT` (the
/// packaging scripts' own env var) remains a development escape hatch.
/// Normal development and every release use the exact submodule pin.
function repoRoot() {
  if (process.env.OPENMMO_CHECKOUT) return process.env.OPENMMO_CHECKOUT
  return path.resolve(__dirname, '..', 'deps', 'OpenMMO')
}

/// Where a packaged build ships the agent-client binary and its seed data.
/// Read-only: once code-signed on macOS (or installed under Program Files on
/// Windows), nothing here can be rewritten at runtime.
function packagedSeedDir() {
  return path.join(process.resourcesPath || '', 'agent-client')
}

/// Working directory for the child process: agent-client resolves every path
/// in its config relative to cwd, so it must be the dir that holds `data/` —
/// and that dir has to be writable, since config.toml is rewritten every
/// start and agent-client itself writes memory.txt and the terrain tile
/// cache into it. A dev checkout is already writable; a packaged build's
/// resources are not, so it gets a runtime dir under userData instead,
/// seeded from the read-only bundle by seedRuntimeData().
function agentDir() {
  if (app.isPackaged) return path.join(app.getPath('userData'), 'agent-runtime')
  return path.join(repoRoot(), 'agent-client')
}

/// The subset of data/ that is fixed content rather than runtime state —
/// safe to ship read-only and copy into place once. Everything else
/// (config.toml, memory.txt, data/cache/*) is either regenerated on every
/// start or grows at runtime and has no business being in the bundle.
const SEED_ENTRIES = ['system_prompt.txt', 'user_prompts', 'templates', 'animation_durations.json']

/// Re-seeded on every version change, not just the first run. These files
/// track the agent-client we bundle — a release that reworks the system
/// prompt or adds an animation duration ships a binary that expects the new
/// copy. Before auto-update that mostly self-corrected, because upgrading
/// meant a fresh install; with updates landing in place, a never-overwrite
/// rule would pin every user's prompts to whichever version they first
/// installed. syncSeed() keeps hand edits regardless (src/seedSync.js).
function seedRuntimeData() {
  if (!app.isPackaged) return
  return syncSeed({
    seedDir: path.join(packagedSeedDir(), 'data'),
    runtimeDir: path.join(agentDir(), 'data'),
    version: app.getVersion(),
    entries: SEED_ENTRIES,
  })
}

/// { parentCommit, openmmoCommit, protocolVersion } for the exact desktop and
/// OpenMMO sources staged into this package. Written by
/// scripts/package-resources.sh; null outside a packaged build or for builds
/// that predate the stamp.
function buildInfo() {
  if (!app.isPackaged) return null
  try {
    return JSON.parse(fs.readFileSync(path.join(packagedSeedDir(), 'build-info.json'), 'utf8'))
  } catch {
    return null
  }
}

/// Used only when neither a package stamp nor a development checkout can be
/// read. Release gates separately require the pinned protocol to appear in
/// verifiedProtocols; this fallback must be one of those versions.
const FALLBACK_PROTOCOL_VERSION = releaseConfig.fallbackProtocol

/// PROTOCOL_VERSION as written in a checkout's `shared/src/lib.rs`, or null if
/// there is no checkout to read (a packaged app's own directory, for one).
function protocolVersionInCheckout(root) {
  try {
    const lib = fs.readFileSync(path.join(root, 'shared', 'src', 'lib.rs'), 'utf8')
    const match = lib.match(/PROTOCOL_VERSION: u32 = (\d+)/)
    return match ? Number(match[1]) : null
  } catch {
    return null
  }
}

/// What the pre-flight session puts in `ClientInfo` (the protocol guard). This
/// follows OpenMMO instead of being hand-maintained, because the two can only
/// ever be wrong together: the version travels with the binary and the client
/// we bundle, all three staged from one checkout by
/// `scripts/package-resources.sh`, and the server refuses anything that is not
/// an exact match (connection.rs). A number that lagged the bundle by a commit
/// meant the pre-flight was refused while the agent we shipped alongside it
/// would have been fine.
///
/// Two sources, in order: the number stamped into `build-info.json` at stage
/// time (the packaged case — there is no checkout inside a .app to read), then
/// the checkout itself (`npm start` in dev). An earlier version of this
/// function rejected deriving this at all, but for a case that no longer
/// applies: it was reading
/// from `settings.binaryPath`, which could point at a bare binary outside any
/// checkout (`~/Downloads/agent-client`) with no `shared/src/lib.rs` anywhere
/// near it. Neither source here can land in that state — the stamp is written
/// by the script that had the checkout in hand, and both fall through to
/// `FALLBACK_PROTOCOL_VERSION` rather than guessing.
function protocolVersion() {
  const stamped = buildInfo()
  if (stamped && Number.isInteger(stamped.protocolVersion)) return stamped.protocolVersion
  return protocolVersionInCheckout(repoRoot()) ?? FALLBACK_PROTOCOL_VERSION
}

/// The dungeon layout fingerprint this build's OpenMMO sources carry — the
/// second thing the server gates a handshake on since agent-client v0.32.0
/// (`LAYOUT_VERSION` in shared/src/lib.rs; see scripts/layout-version.js).
/// Same two sources as protocolVersion(): the package stamp, then the
/// checkout. Null when neither knows, e.g. a checkout predating the stamp.
function layoutVersion() {
  const stamped = buildInfo()
  if (stamped && typeof stamped.layoutVersion === 'string' && stamped.layoutVersion) {
    return stamped.layoutVersion
  }
  try {
    return require('../scripts/layout-version.js').layoutVersion(repoRoot())
  } catch {
    return null
  }
}

/// A ClientInfo version string with the layout fingerprint appended the way
/// onlinerpg_shared::stamp_layout_version does (`pre-flight+layout.1f3c…`).
/// The server refuses an unstamped string outright, so an unknown fingerprint
/// is left bare on purpose: that refusal names the real problem (a stale
/// desktop build), where a made-up stamp would only move it.
function stampLayoutVersion(version) {
  const layout = layoutVersion()
  return layout ? `${version}+layout.${layout}` : version
}

module.exports = {
  repoRoot,
  packagedSeedDir,
  agentDir,
  seedRuntimeData,
  buildInfo,
  protocolVersion,
  layoutVersion,
  stampLayoutVersion,
}
