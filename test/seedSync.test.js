'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { syncSeed, STATE_FILE } = require('../src/seedSync')

const ENTRIES = ['system_prompt.txt', 'user_prompts']

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openmmo-seed-'))
  const seed = path.join(root, 'seed')
  const runtime = path.join(root, 'runtime')
  fs.mkdirSync(path.join(seed, 'user_prompts'), { recursive: true })
  fs.mkdirSync(runtime, { recursive: true })
  fs.writeFileSync(path.join(seed, 'system_prompt.txt'), 'v1 prompt')
  fs.writeFileSync(path.join(seed, 'user_prompts', 'fight.txt'), 'v1 fight')
  return { root, seed, runtime }
}

const read = (dir, ...rel) => fs.readFileSync(path.join(dir, ...rel), 'utf8')

function sync(dirs, version) {
  return syncSeed({ seedDir: dirs.seed, runtimeDir: dirs.runtime, version, entries: ENTRIES, stamp: '1' })
}

test('a first install copies the bundle and records what it wrote', (t) => {
  const dirs = fixture()
  t.after(() => fs.rmSync(dirs.root, { recursive: true, force: true }))

  const result = sync(dirs, '1.0.0')

  assert.equal(read(dirs.runtime, 'system_prompt.txt'), 'v1 prompt')
  assert.equal(read(dirs.runtime, 'user_prompts', 'fight.txt'), 'v1 fight')
  assert.equal(result.backup, null)
  assert.deepEqual(result.kept, [])
  assert.equal(JSON.parse(read(dirs.runtime, STATE_FILE)).version, '1.0.0')
})

test('the same version does no work at all', (t) => {
  const dirs = fixture()
  t.after(() => fs.rmSync(dirs.root, { recursive: true, force: true }))

  sync(dirs, '1.0.0')
  fs.writeFileSync(path.join(dirs.seed, 'system_prompt.txt'), 'v2 prompt')

  assert.equal(sync(dirs, '1.0.0').skipped, true)
  assert.equal(read(dirs.runtime, 'system_prompt.txt'), 'v1 prompt')
})

test('a new version replaces files the user never touched', (t) => {
  const dirs = fixture()
  t.after(() => fs.rmSync(dirs.root, { recursive: true, force: true }))

  sync(dirs, '1.0.0')
  fs.writeFileSync(path.join(dirs.seed, 'system_prompt.txt'), 'v2 prompt')
  fs.writeFileSync(path.join(dirs.seed, 'user_prompts', 'fish.txt'), 'v2 fish')

  const result = sync(dirs, '1.1.0')

  assert.equal(read(dirs.runtime, 'system_prompt.txt'), 'v2 prompt')
  assert.equal(read(dirs.runtime, 'user_prompts', 'fish.txt'), 'v2 fish')
  assert.deepEqual(result.kept, [])
})

test('a new version leaves a hand-edited file alone, this release and the next', (t) => {
  const dirs = fixture()
  t.after(() => fs.rmSync(dirs.root, { recursive: true, force: true }))

  sync(dirs, '1.0.0')
  fs.writeFileSync(path.join(dirs.runtime, 'system_prompt.txt'), 'mine')
  fs.writeFileSync(path.join(dirs.seed, 'system_prompt.txt'), 'v2 prompt')

  assert.deepEqual(sync(dirs, '1.1.0').kept, ['system_prompt.txt'])
  assert.equal(read(dirs.runtime, 'system_prompt.txt'), 'mine')

  // The baseline must stay at the last version the bundle wrote, or the next
  // release would see a match against v2 and quietly overwrite the edit.
  fs.writeFileSync(path.join(dirs.seed, 'system_prompt.txt'), 'v3 prompt')
  assert.deepEqual(sync(dirs, '1.2.0').kept, ['system_prompt.txt'])
  assert.equal(read(dirs.runtime, 'system_prompt.txt'), 'mine')
})

test('an install predating the state file is backed up once, then re-seeded', (t) => {
  const dirs = fixture()
  t.after(() => fs.rmSync(dirs.root, { recursive: true, force: true }))

  fs.writeFileSync(path.join(dirs.runtime, 'system_prompt.txt'), 'ancient')

  const result = sync(dirs, '1.0.0')

  assert.equal(read(dirs.runtime, 'system_prompt.txt'), 'v1 prompt')
  assert.equal(read(dirs.runtime, '.backup-1', 'system_prompt.txt'), 'ancient')
  assert.equal(result.backup, path.join(dirs.runtime, '.backup-1'))
})
