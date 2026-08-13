'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { renderConfigToml } = require('../src/configToml')
const { DEFAULTS } = require('../src/settingsStore')

/// The Rust side of the history cap lives in the submodule, and a rebase onto
/// a new upstream release is what would silently drop it. Reading the real
/// constants keeps this repo's default and floor honest instead of restating
/// numbers that agent-client may no longer agree with.
function rustConstant(name) {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'deps', 'OpenMMO', 'agent-client', 'src', 'openai.rs'),
    'utf8',
  )
  const match = source.match(new RegExp(`${name}: usize = (\\d+);`))
  assert.ok(match, `agent-client's openai.rs no longer defines ${name}`)
  return Number(match[1])
}

function settings(overrides = {}) {
  return {
    server: 'wss://openmmo.to.nexus/ws',
    terrain: 'https://openmmo.to.nexus',
    authMode: 'npc_token',
    npcAccount: 'npc_test',
    characterClass: 'rogue',
    gender: 'male',
    llm: 'openai',
    models: { codex: 'gpt-5.4-mini', claude: 'sonnet', openrouter: 'qwen/qwen3.7-flash', openai: 'local' },
    openaiBaseUrl: 'http://127.0.0.1:11434/v1',
    reasoningEffort: 'none',
    maxTokens: 4096,
    temperature: 0.7,
    ...overrides,
  }
}

/// The `[openai]` table only — `max_messages` in `[openrouter]` would be read
/// by nobody, since agent-client's OpenRouter constructor passes the default.
function openaiTable(toml) {
  const tables = toml.split(/^\[/m)
  const table = tables.find((section) => section.startsWith('openai]'))
  assert.ok(table, 'generated config has no [openai] table')
  return table
}

test('history cap is written into [openai] and nowhere else', () => {
  const toml = renderConfigToml(settings({ maxMessages: 15 }))

  assert.match(openaiTable(toml), /^max_messages = 15$/m)
  assert.equal(toml.match(/^max_messages = /gm).length, 1)
})

test('history cap default matches the cap agent-client hardcoded before it was configurable', () => {
  const fallback = rustConstant('DEFAULT_MAX_MESSAGES')

  assert.equal(DEFAULTS.maxMessages, fallback)
  // Both an unset setting and a stored zero have to land on the same value the
  // agent used when the cap was a `const`.
  for (const value of [undefined, 0, '']) {
    assert.match(openaiTable(renderConfigToml(settings({ maxMessages: value }))), new RegExp(`^max_messages = ${fallback}$`, 'm'))
  }
})

test('history cap is always written as an integer', () => {
  // `max_messages` deserializes into a usize, so a fraction imported from a
  // hand-edited config.toml would stop agent-client from starting at all.
  assert.match(openaiTable(renderConfigToml(settings({ maxMessages: 20.4 }))), /^max_messages = 20$/m)
  assert.match(openaiTable(renderConfigToml(settings({ maxMessages: '30.6' }))), /^max_messages = 31$/m)
})

test('history cap never goes below the floor agent-client would clamp it to', () => {
  const floor = rustConstant('MIN_MAX_MESSAGES')

  // Below the floor the Rust trim computes `turn.len() - (max_messages - 1)`
  // on a usize and panics mid-turn, so a hand-edited config.toml carrying 1
  // must not survive an import round-trip back into the generated file.
  for (const asked of [1, 2, floor]) {
    assert.match(openaiTable(renderConfigToml(settings({ maxMessages: asked }))), new RegExp(`^max_messages = ${floor}$`, 'm'))
  }
  assert.match(openaiTable(renderConfigToml(settings({ maxMessages: floor + 1 }))), new RegExp(`^max_messages = ${floor + 1}$`, 'm'))
})
