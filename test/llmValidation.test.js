'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const { validateLlmSettings } = require('../src/llmValidation')

function settings(llm) {
  return {
    llm,
    models: { codex: 'gpt-5.4-mini', claude: 'sonnet', openrouter: 'model/a', openai: 'model/b' },
    openrouterKey: 'or-key',
    openaiKey: 'oa-key',
    openaiBaseUrl: 'https://llm.example/v1',
  }
}

test('CLI validation checks both executable and authenticated session', async () => {
  const calls = []
  const result = await validateLlmSettings(settings('codex'), {
    exec: async (...args) => calls.push(args),
  })

  assert.deepEqual(result, { ok: true })
  assert.deepEqual(calls, [
    ['codex', ['--version']],
    ['codex', ['login', 'status']],
  ])
})

test('HTTP validation makes one disclosed one-token request with staged settings', async () => {
  let request
  const result = await validateLlmSettings(settings('openai'), {
    fetch: async (url, options) => {
      request = { url, options }
      return { ok: true }
    },
  })

  assert.deepEqual(result, { ok: true })
  assert.equal(request.url, 'https://llm.example/v1/chat/completions')
  assert.equal(request.options.headers.authorization, 'Bearer oa-key')
  assert.deepEqual(JSON.parse(request.options.body), {
    model: 'model/b',
    messages: [{ role: 'user', content: 'Reply with OK.' }],
    max_tokens: 1,
  })
})

test('failed live validation does not report the staged configuration as valid', async () => {
  const result = await validateLlmSettings(settings('openrouter'), {
    fetch: async () => ({ ok: false, status: 401, text: async () => 'invalid key' }),
  })

  assert.equal(result.ok, false)
  assert.match(result.error, /401.*invalid key/)
})
