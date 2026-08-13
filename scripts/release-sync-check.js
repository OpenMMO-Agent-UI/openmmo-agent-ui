'use strict'

/// Checks whether Julian-adv/OpenMMO has published a release we have not yet
/// synced all the way into this repo's submodule pin. "Synced" is
/// derived from git ancestry rather than a state file: if the release
/// commit is already reachable from the commit this repo's HEAD
/// currently pins deps/OpenMMO to, there is nothing left to do.
///
/// This checks the *main repo's pin*, not the fork's master — a run that
/// pushed the fork/branch side but failed before committing the pin bump
/// must still show hasNewRelease: true so the next run retries the
/// remainder, rather than silently treating fork-master ancestry as "done".
///
///   node scripts/release-sync-check.js
///
/// Prints a JSON object and exits 0 whether or not there is new work — the
/// caller reads `hasNewRelease` to decide. Exits non-zero only on a hard
/// error (network, missing remotes, etc).
///
/// Julian's repo is deliberately never added as a persistent remote here —
/// `git fetch <url> tag <name>` pulls just that one tag's object graph into
/// FETCH_HEAD, which is enough for the ancestry check without polluting the
/// fork checkout's remote list or tag namespace (the fetched tag ref is
/// deleted again after use). GitHub's REST compare API can do this same
/// check across a registered fork relationship, but returned 404s in
/// practice even for `master...master` — this local-object approach is what
/// actually works.

const { execFileSync, spawnSync } = require('node:child_process')
const path = require('node:path')

// Not `git rev-parse --show-toplevel` — deps/OpenMMO is itself a git repo, so
// running this from inside it would resolve to the *submodule's* root
// instead of the superproject's. This script always lives at
// <repo root>/scripts/, regardless of the caller's cwd.
const REPO_ROOT = path.resolve(__dirname, '..')
const SUBMODULE = path.join(REPO_ROOT, 'deps', 'OpenMMO')
const UPSTREAM_REPO = 'Julian-adv/OpenMMO'
const UPSTREAM_URL = `https://github.com/${UPSTREAM_REPO}.git`

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function gitIsAncestor(cwd, ancestor, descendant) {
  return spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd, stdio: 'ignore' }).status === 0
}

function gh(...args) {
  return execFileSync('gh', args, { encoding: 'utf8' }).trim()
}

function latestUpstreamRelease() {
  const json = gh(
    'api',
    `repos/${UPSTREAM_REPO}/releases`,
    '--jq',
    '[.[] | select(.draft == false)] | sort_by(.published_at) | reverse | .[0]',
  )
  if (!json) throw new Error(`no releases found on ${UPSTREAM_REPO}`)
  return JSON.parse(json)
}

function protocolVersionAt(sha) {
  const source = git(SUBMODULE, 'show', `${sha}:shared/src/lib.rs`)
  const match = source.match(/PROTOCOL_VERSION: u32 = (\d+)/)
  if (!match) throw new Error(`no PROTOCOL_VERSION readable at ${sha}`)
  return Number(match[1])
}

function versionFromAgentClientTag(tagName) {
  const match = tagName.match(/^agent-client-v(.+)$/)
  if (!match) throw new Error(`release tag is not an agent-client version: ${tagName}`)
  return match[1]
}

function packageVersion(repoRoot) {
  return JSON.parse(require('node:fs').readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version
}

function hasNewRelease({ alreadyPinned, releaseTag, repoRoot = REPO_ROOT }) {
  if (!alreadyPinned) return true
  return packageVersion(repoRoot) !== versionFromAgentClientTag(releaseTag)
}

function main() {
  git(SUBMODULE, 'fetch', 'origin', '--quiet')

  const release = latestUpstreamRelease()
  const tagName = release.tag_name

  git(SUBMODULE, 'fetch', UPSTREAM_URL, 'tag', tagName, '--no-tags', '--quiet')
  const releaseSha = git(SUBMODULE, 'rev-parse', 'FETCH_HEAD')
  // Clean up: the explicit tag fetch above still writes a local tag ref
  // even with --no-tags; drop it so repeated runs don't accumulate one
  // per release checked.
  spawnSync('git', ['tag', '-d', tagName], { cwd: SUBMODULE, stdio: 'ignore' })

  const forkHead = git(SUBMODULE, 'rev-parse', 'origin/master')

  const pinEntry = git(REPO_ROOT, 'ls-tree', 'HEAD', 'deps/OpenMMO')
  const pinMatch = pinEntry.match(/^160000 commit ([0-9a-f]{40})\tdeps\/OpenMMO$/)
  if (!pinMatch) throw new Error('deps/OpenMMO is not an exact submodule gitlink in HEAD')
  const pinnedSha = pinMatch[1]

  const alreadyPinned = gitIsAncestor(SUBMODULE, releaseSha, pinnedSha)

  const protocolVersion = protocolVersionAt(releaseSha)

  const result = {
    hasNewRelease: hasNewRelease({ alreadyPinned, releaseTag: tagName }),
    releaseTag: tagName,
    releaseSha,
    releasePublishedAt: release.published_at,
    protocolVersion,
    forkHead,
    pinnedSha,
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (require.main === module) main()

module.exports = {
  hasNewRelease,
  versionFromAgentClientTag,
}
