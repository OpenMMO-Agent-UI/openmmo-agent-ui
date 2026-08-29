'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { CharacterStore } = require('../src/characterStore')

function fixture() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openmmo-character-store-'))
  return { baseDir, store: new CharacterStore({ baseDir }) }
}

test('reading an unwritten kind returns its default shape', () => {
  const { store } = fixture()
  assert.deepEqual(store.open('labels', 'p1', 'c1').read(), { sellable: [], dropable: [] })
})

test('write then read round-trips', () => {
  const { store } = fixture()
  const labels = store.open('labels', 'p1', 'c1')
  labels.write({ sellable: ['a'], dropable: ['b'] })
  assert.deepEqual(labels.read(), { sellable: ['a'], dropable: ['b'] })
})

test('different profile/character pairs are isolated on disk', () => {
  const { store } = fixture()
  store.open('labels', 'p1', 'c1').write({ sellable: ['a'], dropable: [] })
  assert.deepEqual(store.open('labels', 'p1', 'c2').read(), { sellable: [], dropable: [] })
  assert.deepEqual(store.open('labels', 'p2', 'c1').read(), { sellable: [], dropable: [] })
})

test('a corrupt file falls back to the default instead of throwing', () => {
  const { baseDir, store } = fixture()
  const file = path.join(baseDir, 'labels', 'p1', 'c1.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '{not json')
  assert.deepEqual(store.open('labels', 'p1', 'c1').read(), { sellable: [], dropable: [] })
})

test('a malshaped payload is normalized rather than trusted verbatim', () => {
  const { baseDir, store } = fixture()
  const file = path.join(baseDir, 'labels', 'p1', 'c1.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ sellable: 'not-an-array' }))
  assert.deepEqual(store.open('labels', 'p1', 'c1').read(), { sellable: [], dropable: [] })
})

test('profile and character IDs are sanitized into safe path segments', () => {
  const { baseDir, store } = fixture()
  store.open('labels', '../../etc', 'c/1').write({ sellable: [], dropable: [] })
  const entries = fs.readdirSync(path.join(baseDir, 'labels'))
  assert.deepEqual(entries, ['______etc'])
})

test('rejects an unknown kind', () => {
  const { store } = fixture()
  assert.throws(() => store.open('bogus', 'p1', 'c1'), /Unknown character store kind/)
})
