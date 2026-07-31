'use strict'

/// Compare OpenRouter models on the job the agent actually does.
///
///   OPENROUTER_API_KEY=sk-or-... node scripts/bench-models.js [model ...]
///
/// Price alone picks badly here. The cheap end of the catalogue answers in
/// valid JSON and still invents inventory to sell, or charges a monster forty
/// metres away that the chase will refuse — both burn a turn exactly like a
/// timeout does. So each candidate is scored on decisions, not just schema:
///
///   inventory  the bag holds nothing sellable; selling anything is a fabrication
///   distance   two monsters at 12m, one at 45m; attack gives up past 20m
///
/// Latency and cost come from the same calls, priced against the live
/// catalogue, so the numbers are current rather than remembered.

const fs = require('node:fs')
const path = require('node:path')

const RUNS = 3
/// Matches the app's default. A reasoning model spends part of this thinking
/// before it writes the turn, and the prompt has grown — too tight a budget
/// comes back as empty content, which is indistinguishable from a refusal.
const MAX_TOKENS = 4096
/// Same resolution as config.js's repoRoot(): the pinned submodule checkout,
/// overridable for a dev checkout that lives somewhere else.
const ROOT = process.env.OPENMMO_CHECKOUT || path.resolve(__dirname, '..', 'deps', 'OpenMMO')
const FIXTURES = path.join(__dirname, 'fixtures')

/// Kept in step with the driver's own action list; a well-formed reply full of
/// invented action types is still a wasted turn.
const KNOWN_ACTIONS = new Set([
  'say', 'move', 'attack', 'pickup', 'use', 'respawn', 'wait',
  'sell', 'buy', 'fish', 'stop_fishing', 'open_chest', 'drop', 'reroll',
])

const DEFAULT_MODELS = [
  'qwen/qwen3.7-flash',
  'openai/gpt-oss-20b',
  'anthropic/claude-haiku-4.5',
  'mistralai/mistral-nemo',
  'inclusionai/ling-2.6-flash',
]

const key = process.env.OPENROUTER_API_KEY
if (!key) {
  console.error('Set OPENROUTER_API_KEY (the same key the Model tab holds).')
  process.exit(1)
}

/// The prompt the agent really sends: the shared action schema plus our role
/// file, read from the game tree so the benchmark tracks whatever ships.
function systemPrompt() {
  const parts = ['agent-client/data/system_prompt.txt', 'agent-client/data/user_prompt.txt']
  return parts.map((p) => fs.readFileSync(path.join(ROOT, p), 'utf8')).join('\n\n')
}

function parseTurn(text) {
  const cleaned = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    return JSON.parse(cleaned.slice(start, end + 1))
  } catch {
    return null
  }
}

const SCENARIOS = [
  {
    name: 'inventory',
    file: 'idle-in-town.txt',
    /// Bag is a healing_potion and a fishing rod, both on the never-sell list.
    /// Anything but a sell is fine; a sell means the model imagined stock.
    grade: (turn) => {
      const sells = turn.actions.filter((a) => a.type === 'sell')
      return sells.length === 0 ? null : `invented ${sells.length} sale(s)`
    },
  },
  {
    name: 'distance',
    file: 'monsters-at-range.txt',
    /// kobold and goblin are 12m off, the orc 45m. attack gives up at 20m, so
    /// charging the orc is a turn thrown away.
    grade: (turn) => {
      const first = turn.actions[0]
      if (!first) return 'no action'
      if (first.type !== 'attack') return null // moving to close distance is fair
      return ['m9_2', 'm9_3'].includes(first.monster_id) ? null : 'charged the 45m orc'
    },
  },
]

async function catalogue() {
  const res = await fetch('https://openrouter.ai/api/v1/models')
  const body = await res.json()
  return Object.fromEntries(body.data.map((m) => [m.id, m.pricing]))
}

async function askOnce(model, system, world) {
  const started = Date.now()
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      max_tokens: MAX_TOKENS,
      temperature: 0.7,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: world },
      ],
    }),
    signal: AbortSignal.timeout(90000),
  })
  const ms = Date.now() - started
  if (!res.ok) return { ms, fault: `${res.status} ${(await res.text()).slice(0, 80)}` }

  const body = await res.json()
  const message = body?.choices?.[0]?.message ?? {}
  // A reasoning model that spends its budget thinking leaves content empty.
  const text = message.content?.trim() || message.reasoning?.trim() || ''
  const turn = parseTurn(text)
  const usage = body.usage || {}
  return {
    ms,
    turn,
    fault: turn ? null : 'unparseable',
    promptTokens: usage.prompt_tokens || 0,
    completionTokens: usage.completion_tokens || 0,
  }
}

function verdict(result, scenario) {
  if (result.fault) return result.fault
  const { turn } = result
  if (!Array.isArray(turn.actions) || turn.actions.length === 0) return 'no actions'
  const unknown = turn.actions.find((a) => !KNOWN_ACTIONS.has(a.type))
  if (unknown) return `unknown action ${unknown.type}`
  return scenario.grade(turn)
}

async function main() {
  const models = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_MODELS
  const prices = await catalogue()
  const system = systemPrompt()
  const worlds = SCENARIOS.map((s) => fs.readFileSync(path.join(FIXTURES, s.file), 'utf8'))

  console.log(`system prompt ${system.length} chars · ${RUNS} runs per scenario\n`)
  const head = ['model', 'p50', ...SCENARIOS.map((s) => s.name), '$/turn', '$/8h@8s']
  console.log(head[0].padEnd(34), head[1].padStart(6), ...SCENARIOS.map((s) => s.name.padStart(10)),
    '$/turn'.padStart(9), '$/8h@8s'.padStart(9))

  for (const model of models) {
    const times = []
    const costs = []
    const scores = []
    const notes = new Set()

    for (const [i, scenario] of SCENARIOS.entries()) {
      let passed = 0
      for (let run = 0; run < RUNS; run++) {
        const result = await askOnce(model, system, worlds[i])
        if (!result.fault) times.push(result.ms)
        const price = prices[model] || { prompt: 0, completion: 0 }
        if (result.promptTokens) {
          costs.push(result.promptTokens * +price.prompt + result.completionTokens * +price.completion)
        }
        const problem = verdict(result, scenario)
        if (problem) notes.add(problem)
        else passed++
      }
      scores.push(`${passed}/${RUNS}`)
    }

    times.sort((a, b) => a - b)
    const p50 = times.length ? `${(times[Math.floor(times.length / 2)] / 1000).toFixed(1)}s` : 'FAIL'
    const perTurn = costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : null
    // A night of play at one turn per 8 seconds.
    const nightly = perTurn === null ? null : perTurn * ((8 * 3600) / 8)

    console.log(
      model.padEnd(34),
      p50.padStart(6),
      ...scores.map((s) => s.padStart(10)),
      (perTurn === null ? '-' : `$${perTurn.toFixed(5)}`).padStart(9),
      (nightly === null ? '-' : `$${nightly.toFixed(2)}`).padStart(9),
    )
    for (const note of notes) console.log(`    ${note}`)
  }
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
