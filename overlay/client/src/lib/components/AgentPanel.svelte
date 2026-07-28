<script lang="ts">
  import {
    agentApiKey,
    agentError,
    agentSettings,
    agentTurns,
    clearTurns,
  } from '../agent/agentStore'
  import '../agent/loop'

  let open = $state(false)
  let tab = $state<'setup' | 'thoughts'>('setup')

  // Suggestions only — the field takes any id the endpoint accepts. Check
  // openrouter.ai/models for what is live today.
  const MODELS = ['openai/gpt-oss-20b:free']

  let perHour = $derived(
    Math.round(3600 / Math.max(2, $agentSettings.intervalSecs))
  )

  function toggleAgent() {
    agentSettings.update((s) => ({ ...s, enabled: !s.enabled }))
  }

  function label(kind: string) {
    return kind === 'prompt' ? 'world' : kind
  }
</script>

<div class="agent" class:open>
  <button class="tab" onclick={() => (open = !open)}>
    <span class="dot" class:on={$agentSettings.enabled}></span>
    Agent
  </button>

  {#if open}
    <div class="body">
      <nav>
        <button class:on={tab === 'setup'} onclick={() => (tab = 'setup')}
          >Setup</button
        >
        <button
          class:on={tab === 'thoughts'}
          onclick={() => (tab = 'thoughts')}
        >
          Thoughts
        </button>
      </nav>

      {#if tab === 'setup'}
        <label>
          Model
          <input list="agent-models" bind:value={$agentSettings.model} />
          <datalist id="agent-models">
            {#each MODELS as model (model)}<option value={model}
              ></option>{/each}
          </datalist>
        </label>

        <label>
          API endpoint
          <input bind:value={$agentSettings.baseUrl} />
        </label>

        <label>
          API key
          <input
            type="password"
            bind:value={$agentApiKey}
            placeholder="sk-or-…"
          />
        </label>
        <p class="hint">
          Stored in this browser only and sent straight to the endpoint above.
          Any script that gets into this page can read it, so use a key you can
          revoke.
        </p>

        <label>
          Who your character is
          <textarea rows="6" bind:value={$agentSettings.prompt}></textarea>
        </label>

        <div class="row">
          <label>
            Turn every (s)
            <input
              type="number"
              min="2"
              bind:value={$agentSettings.intervalSecs}
            />
          </label>
          <label>
            Temperature
            <input
              type="number"
              min="0"
              max="2"
              step="0.1"
              bind:value={$agentSettings.temperature}
            />
          </label>
        </div>
        <label class="check">
          <input type="checkbox" bind:checked={$agentSettings.jsonMode} />
          Force JSON replies
        </label>

        <p class="hint">
          One turn is one request — about {perHour} per hour at this interval. Free
          OpenRouter models allow 50 a day (1000 with $10 of credits bought). Changes
          apply on the next turn.
        </p>

        {#if $agentError}<p class="error">{$agentError}</p>{/if}

        <button class="primary" onclick={toggleAgent}>
          {$agentSettings.enabled ? 'Stop playing for me' : 'Let it play'}
        </button>
      {:else}
        <div class="feed">
          {#each $agentTurns.slice().reverse() as turn (turn.id)}
            <div class="turn {turn.kind}">
              <div class="head">
                {new Date(turn.at).toLocaleTimeString()} · {label(turn.kind)}
                {#if turn.ms}· {(turn.ms / 1000).toFixed(1)}s{/if}
              </div>
              <div class="text">{turn.text}</div>
            </div>
          {/each}
        </div>
        <button onclick={clearTurns}>Clear</button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .agent {
    position: fixed;
    top: 96px;
    right: 12px;
    z-index: 60;
    width: 340px;
    color: #dfe3ec;
    font-size: 13px;
  }

  .tab {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-left: auto;
    padding: 6px 12px;
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 8px;
    background: rgba(18, 20, 26, 0.86);
    color: inherit;
    font: inherit;
    cursor: pointer;
  }

  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #6b7280;
  }

  .dot.on {
    background: #5fd48a;
    box-shadow: 0 0 8px rgba(95, 212, 138, 0.7);
  }

  .body {
    margin-top: 8px;
    padding: 12px;
    max-height: 62vh;
    overflow-y: auto;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 10px;
    background: rgba(18, 20, 26, 0.94);
  }

  nav {
    display: flex;
    gap: 4px;
    margin-bottom: 12px;
  }

  nav button {
    flex: 1;
    padding: 5px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: #8b93a5;
    font: inherit;
    cursor: pointer;
  }

  nav button.on {
    background: rgba(255, 255, 255, 0.08);
    color: #dfe3ec;
  }

  label {
    display: block;
    margin-bottom: 10px;
    color: #8b93a5;
  }

  label.check {
    display: flex;
    align-items: center;
    gap: 8px;
    color: #dfe3ec;
  }

  label.check input {
    width: auto;
    margin: 0;
  }

  input,
  textarea {
    width: 100%;
    margin-top: 4px;
    padding: 6px 8px;
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 6px;
    background: rgba(0, 0, 0, 0.3);
    color: #dfe3ec;
    font: inherit;
  }

  textarea {
    resize: vertical;
    font-size: 12px;
  }

  .row {
    display: flex;
    gap: 8px;
  }

  .row label {
    flex: 1;
  }

  .hint {
    margin: -4px 0 10px;
    color: #7c8496;
    font-size: 11px;
  }

  .error {
    margin: 0 0 10px;
    padding: 6px 8px;
    border-radius: 6px;
    background: rgba(120, 30, 30, 0.5);
    color: #ffc9c9;
    font-size: 12px;
  }

  button.primary {
    width: 100%;
    padding: 8px;
    border: none;
    border-radius: 8px;
    background: #ffd76a;
    color: #2a2410;
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }

  .feed {
    max-height: 44vh;
    overflow-y: auto;
    margin-bottom: 8px;
  }

  .turn {
    margin-bottom: 6px;
    padding: 6px 8px;
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.04);
  }

  .head {
    color: #7c8496;
    font-size: 11px;
  }

  .text {
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 12px;
  }

  .turn.prompt .text {
    max-height: 4.5em;
    overflow: hidden;
    color: #98a1b4;
  }

  .turn.thought .text {
    color: #ffd76a;
  }

  .turn.error .text {
    color: #ffb4b4;
  }
</style>
