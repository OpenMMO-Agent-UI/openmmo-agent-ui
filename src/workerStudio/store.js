'use strict'

const fs = require('node:fs')
const path = require('node:path')

const { createDocument, normalizeDocument, validateDocument } = require('./index')

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temp, file)
}

function checked(document) {
  const normalized = normalizeDocument(document)
  const errors = validateDocument(normalized)
  if (errors.length) {
    const first = errors[0]
    throw new Error(`Invalid worker at ${first.path || '/'}: ${first.message}`)
  }
  return normalized
}

class WorkerStore {
  constructor({ file, runtimeFile }) {
    this.file = file
    this.runtimeFile = runtimeFile
  }

  read() {
    let parsed
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch {
      parsed = {}
    }
    return {
      draft: parsed.draft ? normalizeDocument(parsed.draft) : createDocument(),
      active: parsed.active ? normalizeDocument(parsed.active) : null,
      previous: parsed.previous ? normalizeDocument(parsed.previous) : null,
    }
  }

  saveDraft(document) {
    const state = this.read()
    state.draft = checked(document)
    writeJson(this.file, state)
    return clone(state)
  }

  apply() {
    const state = this.read()
    const active = checked(state.draft)
    state.previous = state.active ? clone(state.active) : null
    state.active = active
    writeJson(this.file, state)
    writeJson(this.runtimeFile, active)
    return clone(state)
  }

  materialize() {
    const state = this.read()
    if (!state.active) throw new Error('There is no active worker to materialize')
    writeJson(this.runtimeFile, checked(state.active))
    return clone(state)
  }

  rollback() {
    const state = this.read()
    if (!state.previous) throw new Error('There is no previous worker to restore')
    const restored = checked(state.previous)
    state.previous = state.active ? clone(state.active) : null
    state.active = restored
    state.draft = clone(restored)
    writeJson(this.file, state)
    writeJson(this.runtimeFile, restored)
    return clone(state)
  }
}

module.exports = { WorkerStore }
