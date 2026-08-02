'use strict'

/// Computes the next `agent-client/protocol-v{N}-r{M}` tag for the
/// tweak-agent-client fork given the protocol version the branch will carry
/// after this sync. Same N as the newest existing tag -> r+1 (a re-tag at an
/// unchanged protocol version). Higher N -> r resets to 1.
///
///   node scripts/release-sync-next-tag.js <protocolVersion>

const { execFileSync } = require('node:child_process')
const path = require('node:path')

// Not `git rev-parse --show-toplevel` — deps/OpenMMO is itself a git repo, so
// running this from inside it (as Step 4 of the skill does) would resolve to
// the *submodule's* root instead of the superproject's. This script always
// lives at <repo root>/scripts/, regardless of the caller's cwd.
const REPO_ROOT = path.resolve(__dirname, '..')
const SUBMODULE = path.join(REPO_ROOT, 'deps', 'OpenMMO')
const TAG_PATTERN = /^agent-client\/protocol-v(\d+)-r(\d+)$/

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function main() {
  const protocolVersion = Number(process.argv[2])
  if (!Number.isInteger(protocolVersion) || protocolVersion < 1) {
    throw new Error('usage: release-sync-next-tag.js <protocolVersion>')
  }

  git(SUBMODULE, 'fetch', 'origin', '--tags', '--quiet')
  const tags = git(SUBMODULE, 'tag', '--list', 'agent-client/protocol-v*')
    .split('\n')
    .filter(Boolean)
    .map((tag) => {
      const match = tag.match(TAG_PATTERN)
      return match ? { tag, n: Number(match[1]), r: Number(match[2]) } : null
    })
    .filter(Boolean)

  const sameVersion = tags.filter((t) => t.n === protocolVersion)
  const nextR = sameVersion.length > 0 ? Math.max(...sameVersion.map((t) => t.r)) + 1 : 1

  const nextTag = `agent-client/protocol-v${protocolVersion}-r${nextR}`
  process.stdout.write(`${JSON.stringify({ nextTag, protocolVersion, revision: nextR }, null, 2)}\n`)
}

main()
