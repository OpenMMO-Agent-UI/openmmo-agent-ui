/// Settings and running state for the in-browser agent: the LLM plays *your*
/// character, in your own tab, on your own key. No second session, no second
/// process — the 3D view you are already looking at is the agent's view.

import { writable } from 'svelte/store'

export type AgentBackend = 'openrouter' | 'openai'

export interface AgentSettings {
  enabled: boolean
  backend: AgentBackend
  /// OpenAI-compatible origin plus path prefix; the code appends
  /// `/chat/completions`.
  baseUrl: string
  model: string
  prompt: string
  temperature: number
  maxTokens: number
  /// Floor between turns. Every turn is one request, so this is the dial that
  /// decides both what the agent costs and how long a rate-limited free tier
  /// lasts before it stops answering.
  intervalSecs: number
  /// Ask the endpoint to constrain the reply to JSON. Small models otherwise
  /// wrap the turn in prose the parser has to guess its way out of. Off for
  /// endpoints that reject `response_format`.
  jsonMode: boolean
}

export interface AgentTurn {
  id: number
  at: number
  kind: 'prompt' | 'thought' | 'action' | 'error'
  text: string
  ms?: number
}

const OPENROUTER_URL = 'https://openrouter.ai/api/v1'

const DEFAULT_PROMPT = `You are playing your own character in this world. You are new here and
learn by doing: walk around, talk to whoever you meet, fight what you can
beat, and stay alive. Answer people in the language they spoke to you.`

export const DEFAULT_SETTINGS: AgentSettings = {
  enabled: false,
  backend: 'openrouter',
  baseUrl: OPENROUTER_URL,
  model: 'openai/gpt-oss-20b:free',
  prompt: DEFAULT_PROMPT,
  temperature: 0.7,
  // A reasoning model spends part of this budget thinking before it writes
  // the turn, so a tight cap comes back as an empty reply rather than a
  // short one.
  maxTokens: 2048,
  intervalSecs: 8,
  jsonMode: true,
}

const SETTINGS_KEY = 'openmmo.agent.settings'
/// Kept apart from the settings blob so exporting or sharing settings cannot
/// take the key with it by accident.
const KEY_KEY = 'openmmo.agent.apiKey'

function loadSettings(): AgentSettings {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_SETTINGS }
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }
    // `enabled` is deliberately not restored: a reload should not silently
    // start spending money.
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw), enabled: false }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export const agentSettings = writable<AgentSettings>(loadSettings())

agentSettings.subscribe((value) => {
  if (typeof localStorage === 'undefined') return
  const { enabled: _enabled, ...persisted } = value
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(persisted))
})

export function loadApiKey(): string {
  if (typeof localStorage === 'undefined') return ''
  return localStorage.getItem(KEY_KEY) ?? ''
}

export function saveApiKey(key: string): void {
  if (typeof localStorage === 'undefined') return
  if (key) localStorage.setItem(KEY_KEY, key)
  else localStorage.removeItem(KEY_KEY)
}

export const agentApiKey = writable<string>(loadApiKey())
agentApiKey.subscribe(saveApiKey)

const TURN_CAP = 120

let nextTurnId = 1

export const agentTurns = writable<AgentTurn[]>([])

export function pushTurn(
  kind: AgentTurn['kind'],
  text: string,
  ms?: number
): void {
  agentTurns.update((turns) => {
    const next = [
      ...turns,
      { id: nextTurnId++, at: Date.now(), kind, text, ms },
    ]
    return next.length > TURN_CAP ? next.slice(next.length - TURN_CAP) : next
  })
}

export function clearTurns(): void {
  agentTurns.set([])
}

/// Last error worth showing next to the toggle (a bad key, a refused model).
export const agentError = writable<string>('')
