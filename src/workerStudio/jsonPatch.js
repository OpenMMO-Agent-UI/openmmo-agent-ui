'use strict'

const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor'])

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function pointer(path) {
  if (typeof path !== 'string' || (path !== '' && !path.startsWith('/'))) throw new Error(`invalid JSON Pointer: ${path}`)
  if (path === '') return []
  return path.slice(1).split('/').map((part) => {
    if (/~(?:[^01]|$)/.test(part)) throw new Error(`invalid JSON Pointer escape in ${path}`)
    const segment = part.replace(/~1/g, '/').replace(/~0/g, '~')
    if (FORBIDDEN_SEGMENTS.has(segment)) throw new Error(`unsafe JSON Pointer segment: ${segment}`)
    return segment
  })
}

function arrayIndex(segment, length, operation) {
  if (segment === '-' && operation === 'add') return length
  if (!/^(0|[1-9]\d*)$/.test(segment)) throw new Error(`invalid array index: ${segment}`)
  const index = Number(segment)
  const maximum = operation === 'add' ? length : length - 1
  if (!Number.isSafeInteger(index) || index > maximum) throw new Error(`array index out of bounds: ${segment}`)
  return index
}

function applyJsonPatch(source, operations) {
  if (!Array.isArray(operations)) throw new TypeError('patch must be an array')
  let result = clone(source)
  for (const operation of operations) {
    if (!operation || !['add', 'replace', 'remove'].includes(operation.op)) throw new Error(`unsupported patch operation: ${operation?.op}`)
    if (operation.op !== 'remove' && !Object.hasOwn(operation, 'value')) throw new Error(`${operation.op} operation requires a value`)
    const segments = pointer(operation.path)
    if (segments.length === 0) {
      if (operation.op === 'remove') throw new Error('cannot remove the document root')
      result = clone(operation.value)
      continue
    }
    let parent = result
    for (const segment of segments.slice(0, -1)) {
      if (Array.isArray(parent)) parent = parent[arrayIndex(segment, parent.length, 'replace')]
      else {
        if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, segment)) throw new Error(`path does not exist: ${operation.path}`)
        parent = parent[segment]
      }
    }
    const key = segments.at(-1)
    if (Array.isArray(parent)) {
      const index = arrayIndex(key, parent.length, operation.op)
      if (operation.op === 'add') parent.splice(index, 0, clone(operation.value))
      else if (operation.op === 'replace') parent[index] = clone(operation.value)
      else parent.splice(index, 1)
    } else {
      if (!parent || typeof parent !== 'object') throw new Error(`invalid parent path: ${operation.path}`)
      if (operation.op !== 'add' && !Object.hasOwn(parent, key)) throw new Error(`path does not exist: ${operation.path}`)
      if (operation.op === 'remove') delete parent[key]
      else parent[key] = clone(operation.value)
    }
  }
  return result
}

module.exports = { applyJsonPatch }
