'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const statusPromise = import('../../src/renderer/updateStatus.js')

test('the settings line reports every state, including a dev build', async () => {
  const { statusLine } = await statusPromise
  assert.match(await statusLine({ status: 'disabled' }), /development build/)
  assert.match(statusLine({ status: 'downloading', version: '0.31.0' }), /Downloading v0\.31\.0…/)
  assert.match(statusLine({ status: 'downloading', version: '0.31.0', percent: 62 }), /0\.31\.0 — 62%/)
  assert.match(statusLine({ status: 'ready', version: '0.31.0' }), /ready — restart to install/)
  assert.match(statusLine({ status: 'installing', version: '0.31.0' }), /Installing v0\.31\.0/)
  assert.match(statusLine({ status: 'error' }), /Download the new version manually/)
  assert.match(statusLine({ status: 'idle' }), /Up to date/)
})

test('the settings line carries a refused install rather than claiming the update is ready', async () => {
  const { statusLine } = await statusPromise
  assert.equal(
    statusLine({ status: 'ready', version: '0.31.0', message: 'Move it into /Applications.' }),
    'Move it into /Applications.',
  )
})

test('only a downloaded build offers a restart, and only a stuck one offers the download', async () => {
  const { controlsFor } = await statusPromise
  assert.deepEqual(controlsFor({ status: 'idle' }), { restart: false, download: false })
  assert.deepEqual(controlsFor({ status: 'checking' }), { restart: false, download: false })
  assert.deepEqual(controlsFor({ status: 'downloading', percent: 40 }), { restart: false, download: false })
  assert.deepEqual(controlsFor({ status: 'ready', version: '0.31.0' }), { restart: true, download: false })
  assert.deepEqual(controlsFor({ status: 'error' }), { restart: false, download: true })
})

test('an install in flight offers nothing — the app is on its way out', async () => {
  const { controlsFor } = await statusPromise
  assert.deepEqual(controlsFor({ status: 'installing', version: '0.31.0' }), { restart: false, download: false })
})

test('a refused install keeps the retry and adds the way out', async () => {
  const { controlsFor } = await statusPromise
  // The build is still on disk, so moving the app and clicking again is the
  // fix; the download page is there for when it is not.
  assert.deepEqual(controlsFor({ status: 'ready', version: '0.31.0', message: 'Move it into /Applications.' }), {
    restart: true,
    download: true,
  })
})

test('paintRule draws a measured bar, a full one, and the travelling lamp', async () => {
  const { paintRule } = await statusPromise
  const el = {
    style: {
      width: '',
      removeProperty() {
        this.width = ''
      },
    },
    classList: {
      set: new Set(),
      toggle(name, on) {
        if (on) this.set.add(name)
        else this.set.delete(name)
      },
    },
  }
  paintRule(el, 62)
  assert.equal(el.style.width, '62%')
  assert.equal(el.classList.set.has('indeterminate'), false)

  paintRule(el, 'full')
  assert.equal(el.style.width, '100%')

  paintRule(el, 'indeterminate')
  assert.equal(el.classList.set.has('indeterminate'), true)
  // The lamp's width belongs to the stylesheet, not to a leftover percentage.
  assert.equal(el.style.width, '')

  paintRule(el, 140)
  assert.equal(el.style.width, '100%')
})
