'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const bannerPromise = import('../../src/renderer/updateBanner.js')

test('only a ready or failed update earns the banner', async () => {
  const { bannerFor } = await bannerPromise
  assert.equal(bannerFor({ status: 'idle' }), null)
  assert.equal(bannerFor({ status: 'checking' }), null)
  assert.equal(bannerFor({ status: 'downloading', version: '0.31.0' }), null)
  assert.deepEqual(bannerFor({ status: 'ready', version: '0.31.0' }), {
    text: 'v0.31.0 is ready to install.',
    restart: true,
    download: false,
  })
})

test('a failed update offers the manual download instead of a restart', async () => {
  const { bannerFor } = await bannerPromise
  assert.deepEqual(bannerFor({ status: 'error', version: '0.31.0' }), {
    text: 'v0.31.0 could not install automatically.',
    restart: false,
    download: true,
  })
})

test('the settings line reports every state, including a dev build', async () => {
  const { statusLine } = await bannerPromise
  assert.match(await statusLine({ status: 'disabled' }), /development build/)
  assert.match(statusLine({ status: 'downloading', version: '0.31.0' }), /Downloading v0\.31\.0/)
  assert.match(statusLine({ status: 'idle' }), /Up to date/)
})
