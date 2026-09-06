'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const { buildWorkerPatch } = require('../src/workerStudio/builder')

function settings(extra = {}) {
  return {
    llm: 'openai',
    openaiBaseUrl: 'https://llm.example/v1/',
    openaiKey: 'sk-secret',
    models: { openai: 'test-model' },
    ...extra,
  }
}

test('unavailable inputs and backends never reach the network', async () => {
  let calls = 0
  const fetch = async () => {
    calls += 1
  }
  const valid = { document: { version: 1 }, message: 'make it blue' }
  const cases = [
    [settings({ llm: 'codex' }), valid, /HTTP backend/],
    [settings({ openaiBaseUrl: '' }), valid, /configured/],
    [settings(), { ...valid, message: '   ' }, /message/],
    [settings(), null, /message/],
    [settings(), { ...valid, document: null }, /document/],
    [settings(), { ...valid, document: '' }, /document/],
  ]

  for (const [config, input, expected] of cases) {
    const result = await buildWorkerPatch(config, input, { fetch })
    assert.equal(result.ok, false)
    assert.match(result.error, expected)
  }
  assert.equal(calls, 0)
})

test('posts the patch contract and returns a valid patch', async () => {
  let call
  const fetch = async (url, init) => {
    call = { url, init }
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"summary":"Blue title","patch":[{"op":"replace","path":"/title/color","value":"blue"}]}' } }],
      }),
    }
  }
  const document = { version: 'openmmo-worker/v1', title: { color: 'red' } }

  const result = await buildWorkerPatch(settings(), { document, message: 'make it blue' }, { fetch })

  assert.deepEqual(result, {
    ok: true,
    summary: 'Blue title',
    patch: [{ op: 'replace', path: '/title/color', value: 'blue' }],
  })
  assert.equal(call.url, 'https://llm.example/v1/chat/completions')
  assert.equal(call.init.method, 'POST')
  assert.equal(call.init.headers.authorization, 'Bearer sk-secret')
  assert.equal(call.init.headers['content-type'], 'application/json')
  assert.ok(call.init.signal instanceof AbortSignal)
  const body = JSON.parse(call.init.body)
  assert.equal(body.model, 'test-model')
  assert.equal(body.temperature, 0)
  assert.deepEqual(body.response_format, { type: 'json_object' })
  assert.match(body.messages[0].content, /openmmo-worker v1/i)
  assert.match(body.messages[0].content, /add, replace, or remove/i)
  assert.match(body.messages[0].content, /arbitrary code|eval/i)
  assert.match(body.messages[0].content, /prototype/i)
  assert.match(body.messages[0].content, /secrets.*credentials.*memory.*snapshots/i)
  assert.match(body.messages[0].content, /unsupported actions/i)
  assert.match(body.messages[1].content, /make it blue/)
  assert.match(body.messages[1].content, /"color": "red"/)
})

test('accepts one surrounding JSON fence and omits absent authorization', async () => {
  let authorization = 'not-called'
  const fetch = async (_url, init) => {
    authorization = init.headers.authorization
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '```json\n{"summary":"Removed","patch":[{"op":"remove","path":"/title"}]}\n```' } }],
      }),
    }
  }

  const result = await buildWorkerPatch(
    settings({ openaiKey: '' }),
    { document: {}, message: 'remove title' },
    { fetch },
  )

  assert.deepEqual(result, {
    ok: true,
    summary: 'Removed',
    patch: [{ op: 'remove', path: '/title' }],
  })
  assert.equal(authorization, undefined)
})

test('rejects malformed JSON, response shapes, and patch operations', async () => {
  const contents = [
    'not json',
    '{"summary":"missing patch"}',
    '{"summary":"bad op","patch":[{"op":"move","from":"/a","path":"/b"}]}',
    '{"summary":"missing value","patch":[{"op":"add","path":"/a"}]}',
    '{"summary":"bad path","patch":[{"op":"remove","path":"not-a-pointer"}]}',
  ]

  for (const content of contents) {
    const result = await buildWorkerPatch(
      settings(),
      { document: {}, message: 'change it' },
      {
        fetch: async () => ({
          ok: true,
          json: async () => ({ choices: [{ message: { content } }] }),
        }),
      },
    )
    assert.equal(result.ok, false, content)
    assert.match(result.error, /invalid|malformed/i)
  }
})

test('rejects prototype-pollution paths', async () => {
  for (const path of ['/__proto__/polluted', '/constructor/prototype/x', '/safe/prototype']) {
    const content = JSON.stringify({
      summary: 'unsafe',
      patch: [{ op: 'add', path, value: true }],
    })
    const result = await buildWorkerPatch(
      settings(),
      { document: {}, message: 'change it' },
      {
        fetch: async () => ({
          ok: true,
          json: async () => ({ choices: [{ message: { content } }] }),
        }),
      },
    )
    assert.equal(result.ok, false, path)
    assert.match(result.error, /unsafe|invalid/i)
  }
})

test('rejects oversized responses and patch arrays', async () => {
  const contents = [
    JSON.stringify({ summary: 'x'.repeat(300000), patch: [] }),
    JSON.stringify({
      summary: 'too many edits',
      patch: Array.from({ length: 101 }, (_, index) => ({
        op: 'remove',
        path: `/items/${index}`,
      })),
    }),
  ]

  for (const content of contents) {
    const result = await buildWorkerPatch(
      settings(),
      { document: {}, message: 'change it' },
      {
        fetch: async () => ({
          ok: true,
          json: async () => ({ choices: [{ message: { content } }] }),
        }),
      },
    )
    assert.equal(result.ok, false)
    assert.match(result.error, /large|limit/i)
  }
})

test('returns bounded redacted HTTP error details', async () => {
  const result = await buildWorkerPatch(
    settings(),
    { document: {}, message: 'change it' },
    {
      fetch: async () => ({
        ok: false,
        status: 503,
        text: async () => `provider overloaded sk-secret ${'x'.repeat(1000)}`,
      }),
    },
  )

  assert.equal(result.ok, false)
  assert.match(result.error, /HTTP 503: provider overloaded/)
  assert.doesNotMatch(result.error, /sk-secret/)
  assert.ok(result.error.length <= 350)
})

test('returns safe errors for timeouts and fetch exceptions', async () => {
  const failures = [
    [Object.assign(new Error('request timed out sk-secret'), { name: 'TimeoutError' }), /timed out/i],
    [new Error(`connection failed sk-secret ${'x'.repeat(1000)}`), /connection failed/i],
  ]

  for (const [failure, expected] of failures) {
    const result = await buildWorkerPatch(
      settings(),
      { document: {}, message: 'change it' },
      {
        fetch: async () => {
          throw failure
        },
      },
    )
    assert.equal(result.ok, false)
    assert.match(result.error, expected)
    assert.doesNotMatch(result.error, /sk-secret/)
    assert.ok(result.error.length <= 350)
  }
})
