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
function rustSource() {
  return fs.readFileSync(
    path.join(__dirname, '..', 'deps', 'OpenMMO', 'agent-client', 'src', 'openai.rs'),
    'utf8',
  )
}

function rustConstantOr(fallback, ...names) {
  const source = rustSource()
  for (const name of names) {
    const match = source.match(new RegExp(`${name}: usize = (\\d+);`))
    if (match) return Number(match[1])
  }
  return fallback
}

function rustConstant(...names) {
  const value = rustConstantOr(null, ...names)
  if (value != null) return value
  assert.fail(`agent-client's openai.rs no longer defines ${names.join(' or ')}`)
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
  const fallback = rustConstant('DEFAULT_MAX_MESSAGES', 'MAX_MESSAGES')

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
  const floor = rustConstantOr(3, 'MIN_MAX_MESSAGES')

  // Below the floor the Rust trim computes `turn.len() - (max_messages - 1)`
  // on a usize and panics mid-turn, so a hand-edited config.toml carrying 1
  // must not survive an import round-trip back into the generated file.
  for (const asked of [1, 2, floor]) {
    assert.match(openaiTable(renderConfigToml(settings({ maxMessages: asked }))), new RegExp(`^max_messages = ${floor}$`, 'm'))
  }
  assert.match(openaiTable(renderConfigToml(settings({ maxMessages: floor + 1 }))), new RegExp(`^max_messages = ${floor + 1}$`, 'm'))
})

/// The `[npcs.worker]` table, which decides whether Automatic play runs the
/// LLM agent or one of agent-client's rule engines.
function workerTable(toml) {
  const table = toml.split(/^\[/m).find((section) => section.startsWith('npcs.worker]'))
  assert.ok(table, 'generated config has no [npcs.worker] table')
  return table
}

test('the engine picker and its knobs reach the generated config', () => {
  const toml = renderConfigToml(
    settings({
      workerKind: 'fighter',
      workerLevelMargin: 4,
      workerLowHealthPct: 55,
      workerFoodStock: 4,
      workerPotionStock: 6,
      workerScrollStock: 3,
      workerBagFullPct: 70,
    }),
  )

  const table = workerTable(toml)
  assert.match(table, /^kind = "fighter"$/m)
  assert.match(table, /^level_margin = 4$/m)
  assert.match(table, /^low_health_pct = 55$/m)
  assert.match(table, /^food_stock = 4$/m)
  assert.match(table, /^potion_stock = 6$/m)
  assert.match(table, /^scroll_stock = 3$/m)
  assert.match(table, /^bag_full_pct = 70$/m)
})

test('no worker selected still writes the table, so switching back keeps the knobs', () => {
  const table = workerTable(renderConfigToml(settings({ ...DEFAULTS, workerKind: 'none' })))

  assert.match(table, /^kind = "none"$/m)
  assert.match(table, new RegExp(`^level_margin = ${DEFAULTS.workerLevelMargin}$`, 'm'))
})

test('worker knobs are written as integers agent-client can deserialize', () => {
  // level_margin and the percentages are u32 in Rust: a fraction from a
  // hand-edited config.toml would stop the agent from starting at all.
  const table = workerTable(
    renderConfigToml(settings({ workerLevelMargin: 2.6, workerLowHealthPct: '40.2', workerBagFullPct: 220 })),
  )

  assert.match(table, /^level_margin = 3$/m)
  assert.match(table, /^low_health_pct = 40$/m)
  assert.match(table, /^bag_full_pct = 100$/m, 'a percentage over 100 is nonsense, not a threshold')
})

test('a worker run tells agent-client there is no LLM at all', () => {
  const toml = renderConfigToml(settings({ llm: 'openai', workerKind: 'fisher' }))

  assert.match(toml, /^llm = "none"$/m)
  assert.match(workerTable(toml), /^kind = "fisher"$/m)
  assert.match(renderConfigToml(settings({ llm: 'openai' })), /^llm = "openai"$/m)
})

test('a blank threshold falls back to the default instead of writing 0', () => {
  // 0 is a real answer here — never drink, always go to town — so an
  // unanswered field must not silently become one.
  const table = workerTable(renderConfigToml(settings({ workerLowHealthPct: '', workerBagFullPct: undefined })))

  assert.match(table, /^low_health_pct = 70$/m)
  assert.match(table, /^bag_full_pct = 90$/m)
})
