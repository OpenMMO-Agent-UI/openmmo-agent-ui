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
