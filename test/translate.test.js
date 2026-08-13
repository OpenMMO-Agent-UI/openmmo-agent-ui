'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const { translateText, isConfigured } = require('../src/translate')

function settings(extra) {
  return {
    translateBaseUrl: 'http://192.168.1.120:1234/v1/',
    translateModel: 'gemma-4-e2b-it-mlx',
    ...extra,
  }
}

function reply(content) {
  return async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
  })
}

test('unconfigured settings never reach the network', async () => {
  let called = false
  const fetch = async () => {
    called = true
  }
  for (const patch of [{ translateBaseUrl: '' }, { translateModel: '' }]) {
    const result = await translateText(settings(patch), { text: 'hi', target: 'English' }, { fetch })
    assert.equal(result.ok, false)
  }
  assert.equal(called, false)
  assert.equal(isConfigured(settings()), true)
})

test('borrows the agent endpoint, and falls back when there is none to borrow', async () => {
  const calls = []
  const fetch = async (url, init) => {
    calls.push({ url, model: JSON.parse(init.body).model, auth: init.headers.authorization })
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) }
  }
  const shared = settings({
    translateUseLlmProvider: true,
    models: { openrouter: 'qwen/qwen3.7-flash', openai: 'local-model' },
    openrouterKey: 'or-key',
    openaiKey: 'oai-key',
    openaiBaseUrl: 'https://host/v1/',
  })
  const ask = (extra) => translateText({ ...shared, ...extra }, { text: 'hi', target: 'English' }, { fetch })

  await ask({ llm: 'openrouter' })
  await ask({ llm: 'openai' })
  // A CLI backend has no endpoint to share, so the typed-in fields still win
  // rather than the call failing.
  await ask({ llm: 'codex' })

  assert.deepEqual(calls, [
    {
      url: 'https://openrouter.ai/api/v1/chat/completions',
      model: 'qwen/qwen3.7-flash',
      auth: 'Bearer or-key',
    },
    { url: 'https://host/v1/chat/completions', model: 'local-model', auth: 'Bearer oai-key' },
    {
      url: 'http://192.168.1.120:1234/v1/chat/completions',
      model: 'gemma-4-e2b-it-mlx',
      auth: undefined,
    },
  ])
  assert.equal(isConfigured({ ...shared, llm: 'openrouter' }), true)
  // Borrowing an agent that has no model configured yet is not configured.
  assert.equal(
    isConfigured({ translateUseLlmProvider: true, llm: 'openrouter', models: {} }),
    false,
  )
})

test('posts the translation-only contract and returns the reply verbatim', async () => {
  let url = null
  let init = null
  const fetch = async (u, i) => {
    url = u
    init = i
    return { ok: true, json: async () => ({ choices: [{ message: { content: '  請幫我！  ' } }] }) }
  }

  const result = await translateText(
    settings(),
    { text: '도와주세요!', target: 'Chinese (Traditional)' },
    { fetch },
  )

  assert.deepEqual(result, { ok: true, text: '請幫我！' })
  assert.equal(url, 'http://192.168.1.120:1234/v1/chat/completions')
  const body = JSON.parse(init.body)
  assert.equal(body.temperature, 0)
  assert.equal(body.model, 'gemma-4-e2b-it-mlx')
  assert.equal(body.messages.length, 2)
  assert.equal(body.messages[0].role, 'system')
  assert.match(body.messages[0].content, /into Chinese \(Traditional\)/)
  assert.deepEqual(body.messages[1], { role: 'user', content: '도와주세요!' })
  // No key configured, so no Authorization header to leak to a local endpoint.
  assert.equal(init.headers.authorization, undefined)
})

test('sends the API key only when one is configured', async () => {
  let init = null
  const fetch = async (_u, i) => {
    init = i
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) }
  }
  await translateText(settings({ translateKey: 'sk-test' }), { text: 'a', target: 'English' }, { fetch })
  assert.equal(init.headers.authorization, 'Bearer sk-test')
})

test('an explanation instead of a translation is rejected, not displayed', async () => {
  const essay =
    'Here are a few ways to translate this into Traditional Chinese, depending on the desired tone:\n\n' +
    '**Option 1: Direct and slightly formal**\n\n> 您要不要？有火把、麵包、藥。\n\n' +
    '**Option 2: More inviting**\n\n> 我給您。有火把、麵包和藥。\n\n' +
    'Which one to use depends on the context of the scene you are translating.'

  const result = await translateText(
    settings(),
    { text: '도와줘', target: 'Chinese (Traditional)' },
    { fetch: reply(essay) },
  )

  assert.equal(result.ok, false)
  assert.match(result.error, /explanation/)
})

test('an HTTP error and an empty reply both fail without throwing', async () => {
  const http = await translateText(
    settings(),
    { text: 'a', target: 'English' },
    { fetch: async () => ({ ok: false, status: 503, text: async () => 'model not loaded' }) },
  )
  assert.equal(http.ok, false)
  assert.match(http.error, /HTTP 503: model not loaded/)

  const empty = await translateText(
    settings(),
    { text: 'a', target: 'English' },
    { fetch: reply('   ') },
  )
  assert.equal(empty.ok, false)

  const refused = await translateText(
    settings(),
    { text: 'a', target: 'English' },
    {
      fetch: async () => {
        throw new Error('ECONNREFUSED 192.168.1.120:1234')
      },
    },
  )
  assert.equal(refused.ok, false)
  assert.match(refused.error, /ECONNREFUSED/)
})
