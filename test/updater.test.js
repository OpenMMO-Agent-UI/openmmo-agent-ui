'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const path = require('node:path')

const { macBundlePath, inApplicationsFolder, reduce } = require('../src/updater')

const READY = { status: 'ready', version: '0.41.0', kind: null, percent: 100, message: null }

const HOME = path.join('/', 'Users', 'player')
const MAC_EXE = path.join('/', 'Applications', 'OpenMMO Agent UI.app', 'Contents', 'MacOS', 'OpenMMO Agent UI')
const BUNDLE = path.join('/', 'Applications', 'OpenMMO Agent UI.app')
/// These helpers branch on the platform, and CI runs Linux. Passing it in —
/// rather than letting them read `process.platform` — is what lets the macOS
/// paths actually be exercised anywhere. Without it the three assertions
/// below all took the non-darwin early return, which is how they shipped
/// red on master and aborted the protocol-52 sync at Step 6.
const MAC = 'darwin'

test('macBundlePath walks up from the executable to the .app bundle', () => {
  assert.equal(macBundlePath(MAC_EXE, MAC), BUNDLE)
})

test('a bundle inside /Applications is updatable', () => {
  assert.equal(inApplicationsFolder(MAC_EXE, HOME, MAC), true)
})

test('a bundle inside the per-user Applications folder is updatable', () => {
  const exe = path.join(HOME, 'Applications', 'OpenMMO Agent UI.app', 'Contents', 'MacOS', 'OpenMMO Agent UI')
  assert.equal(inApplicationsFolder(exe, HOME, MAC), true)
})

test('a bundle running from Downloads is refused', () => {
  const exe = path.join(HOME, 'Downloads', 'OpenMMO Agent UI.app', 'Contents', 'MacOS', 'OpenMMO Agent UI')
  assert.equal(inApplicationsFolder(exe, HOME, MAC), false)
})

test('a folder merely prefixed with Applications does not count', () => {
  const exe = path.join('/', 'Applications.app', 'Contents', 'MacOS', 'X')
  assert.equal(inApplicationsFolder(exe, HOME, MAC), false)
})

test('no bundle path (non-mac) is never blocked', () => {
  assert.equal(inApplicationsFolder(null, HOME, MAC), true)
})

test('a downloaded build survives the hourly re-check that walks over it', () => {
  // The whole round trip: checking → available → downloaded, for the version
  // already sitting on disk. Any of these writing through would retire it,
  // and the restart button goes with it.
  assert.equal(reduce(READY, 'checking-for-update'), null)
  assert.equal(reduce(READY, 'update-available', { version: '0.41.0' }), null)
  assert.equal(reduce(READY, 'update-downloaded', { version: '0.41.0' }), null)
})

test('a downloaded build survives an offline hour and a feed that answers nothing', () => {
  assert.equal(reduce(READY, 'update-not-available'), null)
  assert.deepEqual(reduce(READY, 'error', new Error('ENOTFOUND github.com')), { kind: 'net' })
})

test('a genuinely newer build does take the ready status back', () => {
  assert.deepEqual(reduce(READY, 'update-available', { version: '0.42.0' }), {
    status: 'downloading',
    version: '0.42.0',
    kind: null,
    percent: null,
    message: null,
  })
})

test('an install in flight is not disturbed by anything the feed says', () => {
  const installing = { ...READY, status: 'installing' }
  assert.equal(reduce(installing, 'checking-for-update'), null)
  assert.equal(reduce(installing, 'update-downloaded', { version: '0.41.0' }), null)
  // Except a failure, which leaves the build on disk to try again.
  assert.deepEqual(reduce(installing, 'error', new Error('EACCES')), { status: 'ready', kind: 'permission' })
})

test('download progress is rounded and clamped to something a bar can draw', () => {
  const downloading = { status: 'downloading', version: '0.41.0', percent: null }
  assert.equal(reduce(downloading, 'download-progress', { percent: 61.8 }).percent, 62)
  assert.equal(reduce(downloading, 'download-progress', { percent: 140 }).percent, 100)
  assert.equal(reduce(downloading, 'download-progress', {}).percent, null)
})

test('a check that fails with nothing pending is an offline machine, not a broken update', () => {
  const idle = { status: 'checking', version: null, percent: null }
  assert.deepEqual(reduce(idle, 'error', new Error('ETIMEDOUT')), { status: 'idle', kind: 'net' })
  const mid = { status: 'downloading', version: '0.41.0', percent: 40 }
  assert.deepEqual(reduce(mid, 'error', new Error('sha512 mismatch')), { status: 'error', kind: 'integrity' })
})