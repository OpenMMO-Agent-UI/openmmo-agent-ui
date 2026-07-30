'use strict'

const { execFile } = require('node:child_process')

function defaultExec(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 15000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || stdout || error.message).trim()))
        return
      }
      resolve()
    })
  })
}

function required(settings) {
  const model = settings.models?.[settings.llm]
  if (!model) return `Pick a model for ${settings.llm}`
  if (settings.llm === 'openrouter' && !settings.openrouterKey) {
    return 'OpenRouter needs an API key'
  }
  if (settings.llm === 'openai' && (!settings.openaiBaseUrl || !settings.openaiKey)) {
    return 'OpenAI-compatible mode needs a Base URL and API key'
  }
  return null
}

async function validateCli(settings, exec) {
  const authArgs = settings.llm === 'codex' ? ['login', 'status'] : ['auth', 'status']
  try {
    await exec(settings.llm, ['--version'])
    await exec(settings.llm, authArgs)
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      error: `${settings.llm} CLI is unavailable or not signed in: ${error.message}`,
    }
  }
}

async function validateHttp(settings, request) {
  const base =
    settings.llm === 'openrouter'
      ? 'https://openrouter.ai/api/v1'
      : settings.openaiBaseUrl.replace(/\/+$/, '')
  const key = settings.llm === 'openrouter' ? settings.openrouterKey : settings.openaiKey
  try {
    const response = await request(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: settings.models[settings.llm],
        messages: [{ role: 'user', content: 'Reply with OK.' }],
        max_tokens: 1,
      }),
      signal: AbortSignal.timeout(30000),
    })
    if (!response.ok) {
      const detail = typeof response.text === 'function' ? (await response.text()).slice(0, 300) : ''
      return {
        ok: false,
        error: `LLM validation returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
      }
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: `LLM validation failed: ${error.message}` }
  }
}

async function validateLlmSettings(settings, adapters = {}) {
  if (!['codex', 'claude', 'openrouter', 'openai'].includes(settings.llm)) {
    return { ok: false, error: 'Choose an LLM provider for Automatic play' }
  }
  const missing = required(settings)
  if (missing) return { ok: false, error: missing }
  if (settings.llm === 'codex' || settings.llm === 'claude') {
    return validateCli(settings, adapters.exec || defaultExec)
  }
  return validateHttp(settings, adapters.fetch || fetch)
}

module.exports = { validateLlmSettings }
