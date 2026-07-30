'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  BUILTIN_PROFILE_ID,
  ConnectionProfileStore,
  deriveTerrainOrigin,
} = require('../src/connectionProfiles')

function fixture(legacy = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openmmo-profiles-'))
  const file = path.join(dir, 'profiles.json')
  const cipher = {
    encrypt: (value) => Buffer.from(JSON.stringify(value)).toString('base64'),
    decrypt: (value) => JSON.parse(Buffer.from(value, 'base64').toString('utf8')),
  }
  const store = new ConnectionProfileStore({
    file,
    cipher,
    builtin: {
      name: 'openmmo.to.nexus',
      serverUrl: 'wss://openmmo.to.nexus/ws',
      terrainOrigin: 'https://openmmo.to.nexus',
      googleClientId: 'official.apps.googleusercontent.com',
      googleClientSecret: 'official-secret',
    },
    legacy,
  })
  return { dir, file, store }
}

test('derives the terrain origin from a secure websocket URL', () => {
  assert.equal(deriveTerrainOrigin('wss://realm.example/ws'), 'https://realm.example')
  assert.equal(deriveTerrainOrigin('ws://localhost:8080/ws'), 'http://localhost:8080')
})

test('built-in connection profile is always present and immutable', () => {
  const { store } = fixture()
  const builtin = store.list()[0]

  assert.equal(builtin.id, BUILTIN_PROFILE_ID)
  assert.equal(builtin.kind, 'builtin')
  assert.throws(() => store.update(BUILTIN_PROFILE_ID, { name: 'broken' }), /immutable/)
  assert.throws(() => store.delete(BUILTIN_PROFILE_ID), /immutable/)
})

test('custom profiles support create, update, duplicate, select, and delete', () => {
  const { store } = fixture()
  const custom = store.create({
    name: 'Local Realm',
    serverUrl: 'ws://localhost:9000/ws',
    googleClientId: 'local-client',
    googleClientSecret: 'local-secret',
  })

  assert.equal(custom.terrainOrigin, 'http://localhost:9000')
  assert.equal(store.select(custom.id).id, custom.id)
  assert.equal(store.update(custom.id, { name: 'Renamed Realm' }).name, 'Renamed Realm')

  const copy = store.duplicate(custom.id)
  assert.equal(copy.name, 'Renamed Realm copy')
  assert.equal(copy.hasGoogleClientSecret, true)
  assert.equal(store.credential(copy.id), null)

  store.delete(custom.id)
  assert.equal(store.list().some((profile) => profile.id === custom.id), false)
  assert.equal(store.selected().id, BUILTIN_PROFILE_ID)
})

test('OAuth credentials and last character are isolated by connection profile', () => {
  const { store } = fixture()
  const one = store.create({
    name: 'One',
    serverUrl: 'wss://one.example/ws',
    googleClientId: 'shared-client',
  })
  const two = store.create({
    name: 'Two',
    serverUrl: 'wss://two.example/ws',
    googleClientId: 'shared-client',
  })

  store.setCredential(one.id, 'refresh-one')
  store.setCredential(two.id, 'refresh-two')
  store.rememberSession(one.id, { account: 'one@example.com', characterId: 11 })
  store.rememberSession(two.id, { account: 'two@example.com', characterId: 22 })

  assert.equal(store.credential(one.id), 'refresh-one')
  assert.equal(store.credential(two.id), 'refresh-two')
  assert.deepEqual(store.get(one.id).lastSession, {
    account: 'one@example.com',
    characterId: 11,
  })
  assert.deepEqual(store.get(two.id).lastSession, {
    account: 'two@example.com',
    characterId: 22,
  })

  store.delete(one.id)
  assert.equal(store.credential(one.id), null)
  assert.equal(store.credential(two.id), 'refresh-two')
})

test('legacy custom settings migrate once into an Imported Server profile', () => {
  const legacy = {
    server: 'wss://private.example/ws',
    terrain: 'https://assets.private.example',
    googleClientId: 'private-client',
    googleClientSecret: 'private-secret',
    refreshToken: 'private-refresh',
    characterId: 42,
    account: 'player@example.com',
  }
  const { file, store } = fixture(legacy)

  const imported = store.list().find((profile) => profile.name === 'Imported Server')
  assert.ok(imported)
  assert.equal(imported.serverUrl, legacy.server)
  assert.equal(imported.terrainOrigin, legacy.terrain)
  assert.equal(store.credential(imported.id), legacy.refreshToken)
  assert.equal(store.selected().id, imported.id)

  const reloaded = new ConnectionProfileStore({
    file,
    cipher: {
      encrypt: (value) => Buffer.from(JSON.stringify(value)).toString('base64'),
      decrypt: (value) => JSON.parse(Buffer.from(value, 'base64').toString('utf8')),
    },
    builtin: store.withSecrets(BUILTIN_PROFILE_ID),
    legacy: { ...legacy, server: 'wss://should-not-import.example/ws' },
  })
  assert.equal(reloaded.list().filter((profile) => profile.name === 'Imported Server').length, 1)
})
