'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

function loadPreload() {
  let api
  const calls = []
  const listeners = new Map()
  const ipcRenderer = {
    invoke(...args) {
      calls.push(args)
      return args
    },
    on(channel, listener) {
      listeners.set(channel, listener)
    },
    off(channel, listener) {
      if (listeners.get(channel) === listener) listeners.delete(channel)
    },
  }
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8')
  vm.runInNewContext(source, {
    require(name) {
      assert.equal(name, 'electron')
      return {
        contextBridge: { exposeInMainWorld(_name, exposed) { api = exposed } },
        ipcRenderer,
      }
    },
  })
  return { api, calls, listeners }
}

test('preload exposes the Worker Studio API with fixed IPC payloads', () => {
  const { api, calls } = loadPreload()
  const document = { format: 'openmmo-worker' }
  const snapshots = [{ name: 'safe', snapshot: {} }]

  api.getWorkerState()
  api.saveWorkerDraft(document)
  api.validateWorker(document)
  api.simulateWorker({ document, snapshots })
  api.simulateWorker()
  api.customizeWorker({ document, message: 'Be cautious' })
  api.applyWorker(document)
  api.rollbackWorker()
  api.importWorker()
  api.exportWorker()
  api.openWorkerFolder()

  assert.deepEqual(calls.slice(-11).map(([channel]) => channel), [
    'worker:get-state',
    'worker:save-draft',
    'worker:validate',
    'worker:simulate',
    'worker:simulate',
    'worker:customize',
    'worker:apply',
    'worker:rollback',
    'worker:import',
    'worker:export',
    'worker:open-folder',
  ])
  assert.equal(calls.at(-10)[1], document)
  assert.equal(calls.at(-8)[1].document, document)
  assert.equal(calls.at(-8)[1].snapshots, snapshots)
  assert.equal(calls.at(-7)[1].document, undefined)
  assert.equal(calls.at(-7)[1].snapshots, undefined)
  assert.equal(calls.at(-6)[1].document, document)
  assert.equal(calls.at(-6)[1].message, 'Be cautious')
})

test('worker trace subscription forwards payloads and can unsubscribe', () => {
  const { api, listeners } = loadPreload()
  let received
  const unsubscribe = api.onWorkerTrace((payload) => { received = payload })
  const listener = listeners.get('worker:trace')

  listener({}, [{ k: 'worker', m: 'trace' }])
  assert.deepEqual(received, [{ k: 'worker', m: 'trace' }])
  unsubscribe()
  assert.equal(listeners.has('worker:trace'), false)
})