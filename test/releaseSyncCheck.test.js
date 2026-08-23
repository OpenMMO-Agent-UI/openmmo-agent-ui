'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  hasNewRelease,
  versionFromAgentClientTag,
} = require('../scripts/release-sync-check')

function makePackage(version) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openmmo-release-sync-check-'))
  fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({ version })}\n`)
  return {
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
    root,
  }
}

test('treats a newer upstream app version as unsynced even when the release commit is already pinned', () => {
  const fixture = makePackage('0.23.0')
  try {
    assert.equal(
      hasNewRelease({
        alreadyPinned: true,
        releaseTag: 'agent-client-v0.24.0',
        repoRoot: fixture.root,
      }),
      true,
    )
  } finally {
    fixture.cleanup()
  }
})

test('treats a pinned release as synced when package version matches the upstream tag', () => {
  const fixture = makePackage('0.24.0')
  try {
    assert.equal(
      hasNewRelease({
        alreadyPinned: true,
        releaseTag: 'agent-client-v0.24.0',
        repoRoot: fixture.root,
      }),
      false,
    )
  } finally {
    fixture.cleanup()
  }
})

test('parses the desktop version from an agent-client release tag', () => {
  assert.equal(versionFromAgentClientTag('agent-client-v0.24.0'), '0.24.0')
  assert.equal(versionFromAgentClientTag('agent-client-v1.2.3-beta.1'), '1.2.3-beta.1')
})

// A new release is not the only reason to sync. The live server can stop
// accepting the build we already shipped — a redeploy off upstream master
// moves the dungeon layout fingerprint without a tag or a protocol bump —
// and that lockout has no release attached to it to be noticed by.
const { needsSync } = require('../scripts/release-sync-check.js')

test('a new release still triggers a sync', () => {
  assert.equal(needsSync({ hasNewRelease: true, serverAcceptsPin: true }), true)
})

test('a server that refuses the build we ship triggers a sync on its own', () => {
  assert.equal(needsSync({ hasNewRelease: false, serverAcceptsPin: false }), true)
})

test('nothing to do when the server is happy and there is no new release', () => {
  assert.equal(needsSync({ hasNewRelease: false, serverAcceptsPin: true }), false)
})

test('an unreachable server is not a reason to sync', () => {
  // Two hours of CI on a network blip is worse than waiting for the next run.
  assert.equal(needsSync({ hasNewRelease: false, serverAcceptsPin: null }), false)
  assert.equal(needsSync({ hasNewRelease: true, serverAcceptsPin: null }), true)
})
