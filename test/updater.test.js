'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const path = require('node:path')

const { macBundlePath, inApplicationsFolder } = require('../src/updater')

const HOME = path.join('/', 'Users', 'player')
const MAC_EXE = path.join('/', 'Applications', 'OpenMMO Agent UI.app', 'Contents', 'MacOS', 'OpenMMO Agent UI')
const BUNDLE = path.join('/', 'Applications', 'OpenMMO Agent UI.app')

test('macBundlePath walks up from the executable to the .app bundle', () => {
  assert.equal(macBundlePath(MAC_EXE), BUNDLE)
})

test('a bundle inside /Applications is updatable', () => {
  assert.equal(inApplicationsFolder(MAC_EXE, HOME), true)
})

test('a bundle inside the per-user Applications folder is updatable', () => {
  const exe = path.join(HOME, 'Applications', 'OpenMMO Agent UI.app', 'Contents', 'MacOS', 'OpenMMO Agent UI')
  assert.equal(inApplicationsFolder(exe, HOME), true)
})

test('a bundle running from Downloads is refused', () => {
  const exe = path.join(HOME, 'Downloads', 'OpenMMO Agent UI.app', 'Contents', 'MacOS', 'OpenMMO Agent UI')
  assert.equal(inApplicationsFolder(exe, HOME), false)
})

test('a folder merely prefixed with Applications does not count', () => {
  const exe = path.join('/', 'Applications.app', 'Contents', 'MacOS', 'X')
  assert.equal(inApplicationsFolder(exe, HOME), false)
})

test('no bundle path (non-mac) is never blocked', () => {
  assert.equal(inApplicationsFolder(null, HOME), true)
})
