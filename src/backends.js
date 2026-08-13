'use strict'

/// The backend table on its own, with no electron behind it: settingsStore
/// needs it, llmValidation needs it (and is unit-tested under bare node, so it
/// cannot reach through settingsStore for it), and the renderer is handed the
/// whole array at startup. One definition, three readers.
const BACKENDS = [
  { id: 'codex', label: 'Codex CLI', kind: 'cli', models: ['gpt-5.4-mini', 'gpt-5.4', 'o4-mini'] },
  { id: 'claude', label: 'Claude CLI', kind: 'cli', models: ['sonnet', 'opus', 'haiku'] },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    kind: 'http',
    envKey: 'OPENROUTER_API_KEY',
    /// Fixed, unlike openai's — which is why openrouter has no Base URL field.
    baseUrl: 'https://openrouter.ai/api/v1',
    // Suggestions only; the field takes any id from openrouter.ai/models.
    // Measured on the agent's real turn: these keep the distance rule and read
    // the bag correctly. Cheaper models exist and invent inventory.
    models: [
      'qwen/qwen3.7-flash',
      'openai/gpt-oss-20b',
      'anthropic/claude-haiku-4.5',
    ],
  },
  {
    id: 'openai',
    label: 'OpenAI-compatible',
    kind: 'http',
    envKey: 'OPENAI_COMPAT_API_KEY',
    models: [],
  },
]

/// Where an HTTP backend actually is, and what it answers as. `null` for the
/// CLI backends: they run locally under your own login and have no endpoint to
/// dial — which is what stops chat translation from borrowing them.
function httpEndpoint(settings) {
  const backend = BACKENDS.find((b) => b.id === settings.llm)
  if (!backend || backend.kind !== 'http') return null
  const base = backend.baseUrl || String(settings.openaiBaseUrl || '')
  return {
    base: base.replace(/\/+$/, ''),
    model: settings.models?.[settings.llm] || '',
    key: settings[`${backend.id}Key`] || '',
  }
}

module.exports = { BACKENDS, httpEndpoint }
