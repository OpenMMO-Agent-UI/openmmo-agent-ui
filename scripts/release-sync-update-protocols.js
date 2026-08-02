'use strict'

/// Adds a newly-verified protocol version to config/release.json and moves
/// fallbackProtocol forward to what was, until this call, the newest
/// verified version. A protocol only reaches this script after the sync
/// skill's build+test gate has passed, which is this project's stand-in for
/// the manual verification the field was originally designed to require.
///
///   node scripts/release-sync-update-protocols.js <protocolVersion>
///
/// Idempotent: re-running with a version already present leaves the file
/// unchanged and reports updated: false.

const fs = require('node:fs')
const path = require('node:path')

// Not `git rev-parse --show-toplevel` — cwd-sensitive, and deps/OpenMMO is
// itself a git repo. This script always lives at <repo root>/scripts/,
// regardless of the caller's cwd.
const REPO_ROOT = path.resolve(__dirname, '..')
const CONFIG_PATH = path.join(REPO_ROOT, 'config', 'release.json')

function main() {
  const protocolVersion = Number(process.argv[2])
  if (!Number.isInteger(protocolVersion) || protocolVersion < 1) {
    throw new Error('usage: release-sync-update-protocols.js <protocolVersion>')
  }

  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
  if (config.verifiedProtocols.includes(protocolVersion)) {
    process.stdout.write(`${JSON.stringify({ updated: false, config }, null, 2)}\n`)
    return
  }

  const previousNewest = Math.max(...config.verifiedProtocols)
  config.verifiedProtocols = [...config.verifiedProtocols, protocolVersion].sort((a, b) => a - b)
  config.fallbackProtocol = previousNewest

  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify({ updated: true, config }, null, 2)}\n`)
}

main()
