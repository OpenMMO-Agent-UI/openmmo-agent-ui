/// The turn loop: describe the world, ask the model, run what it chose.
/// It runs in the page that is already playing, so there is no second session
/// and no second process — you watch the agent in the same 3D view you would
/// be playing in, and taking over is just switching it off.

import { get } from 'svelte/store'

import { gameStore } from '../stores/gameStore'
import {
  agentApiKey,
  agentError,
  agentSettings,
  pushTurn,
  type AgentSettings,
} from './agentStore'
import { runActions, type AgentAction } from './actions'
import { buildWorldState } from './worldState'

const SYSTEM_PROMPT = `You are playing a character in an MMORPG through a normal game client.
You are given the world as your character sees it and choose what to do next.

RESPOND WITH ONLY A VALID JSON OBJECT. No markdown, no code fences, no prose.

{
  "thought": "one short line of reasoning",
  "actions": [ ... ]
}

Actions (use these exact field names):
- {"type": "say", "message": "hello"}            speak to everyone nearby.
                                                 "/w Name text" whispers one player.
- {"type": "move", "target": "PlayerName"}       walk up to a person and stop
                                                 at talking distance.
- {"type": "move", "x": 10.0, "z": -5.0}         walk to a coordinate.
- {"type": "move", "direction": "north", "distance": 10}
- {"type": "attack", "monster_id": "m2_1"}       chase and fight a monster.
- {"type": "pickup", "item": 6043}               walk over and pick it up.
- {"type": "use", "item": "healing_potion"}      use or wear something in your bag.
- {"type": "respawn"}                            only when you are dead.
- {"type": "wait"}                               do nothing this turn.

At most 4 actions per turn; they run in order. Reply to people in the
language they used. Do not invent monster or item ids — use the ones in the
world state.`

interface Turn {
  thought?: string
  actions?: AgentAction[]
}

/// Strips the code fence models add even when told not to.
function parseTurn(text: string): Turn | null {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as Turn
  } catch {
    return null
  }
}

async function callModel(
  settings: AgentSettings,
  apiKey: string,
  worldState: string,
  signal: AbortSignal
): Promise<string> {
  const base = settings.baseUrl.replace(/\/$/, '')
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (apiKey) headers.authorization = `Bearer ${apiKey}`

  const response = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify({
      model: settings.model,
      temperature: settings.temperature,
      max_tokens: settings.maxTokens,
      ...(settings.jsonMode
        ? { response_format: { type: 'json_object' } }
        : {}),
      messages: [
        {
          role: 'system',
          content: `${SYSTEM_PROMPT}\n\nWho you are:\n${settings.prompt}`,
        },
        { role: 'user', content: worldState },
      ],
    }),
  })

  if (!response.ok) {
    const body = await response.text()
    // A rate limit is the one failure worth naming: on a free tier it is the
    // expected end of the run, not a misconfiguration to go hunting for.
    if (response.status === 429) {
      throw new Error(
        `Rate limited by the endpoint. Free OpenRouter models allow 20 requests ` +
          `per minute and 50 per day (1000 with $10 of credits bought) — ` +
          `raise the turn interval or switch to a paid model. ${body.slice(0, 120)}`
      )
    }
    throw new Error(
      `${response.status} ${response.statusText}: ${body.slice(0, 200)}`
    )
  }

  const message = (await response.json())?.choices?.[0]?.message
  // Reasoning models put their chain of thought in `reasoning` and the answer
  // in `content`; when the token budget runs out mid-thought, `content` comes
  // back empty and the reasoning is all there is to parse.
  const content = message?.content?.trim()
  if (content) return content
  const reasoning = message?.reasoning?.trim()
  if (reasoning) return reasoning
  throw new Error(
    'The model replied with nothing. Raise max tokens — a reasoning model can ' +
      'spend the whole budget thinking before it writes the turn.'
  )
}

class AgentLoop {
  private timer: ReturnType<typeof setTimeout> | null = null
  private abort: AbortController | null = null
  private running = false

  start(): void {
    if (this.running) return
    this.running = true
    agentError.set('')
    pushTurn('action', 'Agent started.')
    this.schedule(0)
  }

  stop(): void {
    if (!this.running) return
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.abort?.abort()
    this.abort = null
    pushTurn('action', 'Agent stopped.')
  }

  private schedule(delayMs: number): void {
    if (!this.running) return
    this.timer = setTimeout(() => void this.tick(), delayMs)
  }

  private async tick(): Promise<void> {
    if (!this.running) return
    const settings = get(agentSettings)
    const apiKey = get(agentApiKey)
    const interval = Math.max(2, settings.intervalSecs) * 1000

    // Nothing to reason about before the character is in the world; check
    // again on the next beat rather than burning a request.
    if (!get(gameStore).currentPlayer) {
      this.schedule(interval)
      return
    }
    if (!settings.model || !apiKey) {
      agentError.set('Set a model and an API key first.')
      this.running = false
      return
    }

    const worldState = buildWorldState()
    pushTurn('prompt', worldState)

    const started = performance.now()
    this.abort = new AbortController()
    try {
      const reply = await callModel(
        settings,
        apiKey,
        worldState,
        this.abort.signal
      )
      const ms = Math.round(performance.now() - started)
      const turn = parseTurn(reply)
      if (!turn) {
        pushTurn(
          'error',
          `Could not parse a turn from:\n${reply.slice(0, 400)}`,
          ms
        )
      } else {
        if (turn.thought) pushTurn('thought', turn.thought, ms)
        const log = runActions(turn.actions ?? [])
        if (log.length) pushTurn('action', log.join('\n'))
      }
      agentError.set('')
    } catch (err) {
      if ((err as Error).name === 'AbortError') return
      const message = (err as Error).message
      agentError.set(message)
      pushTurn('error', message, Math.round(performance.now() - started))
    } finally {
      this.abort = null
    }

    this.schedule(interval)
  }
}

export const agentLoop = new AgentLoop()

/// Drives the loop from the settings toggle, so the panel only has to flip a
/// boolean and every entry point agrees. Only transitions act: editing the
/// model mid-run must not restart the turn timer.
let wasEnabled = false
agentSettings.subscribe((settings) => {
  if (settings.enabled === wasEnabled) return
  wasEnabled = settings.enabled
  if (settings.enabled) agentLoop.start()
  else agentLoop.stop()
})
