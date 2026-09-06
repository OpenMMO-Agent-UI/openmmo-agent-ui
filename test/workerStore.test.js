'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { WorkerStore } = require('../src/workerStudio/store')

function worker(name) {
  return {
    format: 'openmmo-worker',
    version: 1,
    metadata: { name, description: '' },
    rules: [{ id: 'idle', priority: 0, condition: { eq: [true, true] }, actions: [{ action: 'wait' }] }],
  }
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openmmo-workers-'))
  return {
    root,
    runtimeFile: path.join(root, 'runtime', 'active.ommoworker.json'),
    store: new WorkerStore({
      file: path.join(root, 'worker-studio.json'),
      runtimeFile: path.join(root, 'runtime', 'active.ommoworker.json'),
    }),
  }
}

test('a new worker store starts with an editable draft and no active worker', () => {
  const { root, store } = fixture()
  try {
    const state = store.read()
    assert.equal(state.draft.format, 'openmmo-worker')
    assert.equal(state.active, null)
    assert.equal(state.previous, null)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('apply promotes a valid draft, preserves the prior worker, and materializes runtime JSON', () => {
  const { root, runtimeFile, store } = fixture()
  try {
    store.saveDraft(worker('First'))
    store.apply()
    store.saveDraft(worker('Second'))
    const state = store.apply()

    assert.equal(state.active.metadata.name, 'Second')
    assert.equal(state.previous.metadata.name, 'First')
    assert.deepEqual(JSON.parse(fs.readFileSync(runtimeFile, 'utf8')), state.active)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('rollback swaps active and previous and rematerializes the restored worker', () => {
  const { root, runtimeFile, store } = fixture()
  try {
    store.saveDraft(worker('First'))
    store.apply()
    store.saveDraft(worker('Second'))
    store.apply()

    const state = store.rollback()
    assert.equal(state.active.metadata.name, 'First')
    assert.equal(state.previous.metadata.name, 'Second')
    assert.equal(state.draft.metadata.name, 'First')
    assert.equal(JSON.parse(fs.readFileSync(runtimeFile, 'utf8')).metadata.name, 'First')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('materialize restores the active worker without changing version history', () => {
  const { root, runtimeFile, store } = fixture()
  try {
    store.saveDraft(worker('Durable'))
    const before = store.apply()
    fs.rmSync(runtimeFile)

    const state = store.materialize()
    assert.deepEqual(state, before)
    assert.equal(JSON.parse(fs.readFileSync(runtimeFile, 'utf8')).metadata.name, 'Durable')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('invalid drafts and rollback without a previous worker are refused without changing disk', () => {
  const { root, store } = fixture()
  try {
    const before = store.read()
    assert.throws(() => store.saveDraft({ format: 'bad' }), /invalid worker/i)
    assert.deepEqual(store.read(), before)
    assert.throws(() => store.rollback(), /previous worker/i)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
