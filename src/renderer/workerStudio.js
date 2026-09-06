'use strict'

function valueSummary(value) {
  if (value && typeof value === 'object') {
    if (typeof value.ref === 'string') return value.ref
    if (value.count) return `count(${valueSummary(value.count)})`
    if (value.select) return String(value.select)
  }
  if (typeof value === 'string') return JSON.stringify(value)
  return String(value)
}

export function actionSummary(action) {
  if (!action || typeof action !== 'object') return 'Invalid action'
  if (action.intent != null) return `Intent: ${String(action.intent)}`
  const name = String(action.action || action.type || 'Unknown action')
  const detailKeys = ['target', 'monster_id', 'item', 'item_id', 'text', 'direction', 'duration_ms']
  const details = detailKeys
    .filter((key) => action[key] != null)
    .map((key) => key === 'text' ? String(action[key]) : valueSummary(action[key]))
  return [name, ...details].join(' · ')
}

export function cappedAppend(items, item, limit = 100) {
  items.push(item)
  if (items.length > limit) items.splice(0, items.length - limit)
  return items
}

/// agent-client's worker feed carries one entry per changed turn, with the
/// decision as a JSON string in `m`. Flatten a batch into trace entries the
/// panel can draw, keeping unparseable text as a note rather than dropping it.
export function normalizeTrace(payload) {
  const items = Array.isArray(payload) ? payload : payload ? [payload] : []
  return items.filter((item) => item && typeof item === 'object').map((item) => {
    let turn = item
    let note = ''
    if (typeof item.m === 'string') {
      try {
        turn = JSON.parse(item.m)
      } catch {
        turn = {}
        note = item.m
      }
    }
    return {
      timestamp: Number(item.t) || Date.now(),
      matchedRuleId: turn?.rule ?? turn?.ruleId ?? turn?.rule_id ?? null,
      actions: Array.isArray(turn?.actions) ? turn.actions : [],
      note,
    }
  })
}

export function orderedRules(document) {
  const rules = Array.isArray(document?.rules) ? document.rules : []
  return rules
    .map((rule, index) => ({ rule, index }))
    .sort((left, right) => (Number(right.rule.priority) || 0) - (Number(left.rule.priority) || 0) || left.index - right.index)
    .map(({ rule }) => rule)
}

export function conditionSummary(condition) {
  if (typeof condition === 'boolean') return String(condition)
  if (!condition || typeof condition !== 'object') return 'invalid condition'
  if (Array.isArray(condition.all)) return condition.all.map(conditionSummary).join(' AND ')
  if (Array.isArray(condition.any)) return condition.any.map(conditionSummary).join(' OR ')
  if (condition.not) return `NOT (${conditionSummary(condition.not)})`
  if (condition.exists) return `exists ${valueSummary(condition.exists)}`
  const operators = { eq: '=', ne: '≠', lt: '<', lte: '≤', gt: '>', gte: '≥' }
  for (const [key, symbol] of Object.entries(operators)) {
    if (Array.isArray(condition[key])) {
      return condition[key].map(valueSummary).join(` ${symbol} `)
    }
  }
  return 'complex condition'
}

const DEFAULT_SNAPSHOTS = [
  {
    name: 'Healthy near a slime',
    snapshot: {
      self: { health_pct: 85, position: { x: 0, y: 0 } },
      monsters: [{ id: 'example-slime', name: 'Slime', position: { x: 3, y: 0 } }],
      bag: [],
    },
  },
  {
    name: 'Low health',
    snapshot: { self: { health_pct: 20, position: { x: 0, y: 0 } }, monsters: [], bag: [] },
  },
]

function node(tag, className, text) {
  const element = document.createElement(tag)
  if (className) element.className = className
  if (text != null) element.textContent = String(text)
  return element
}

function workerName(document) {
  return document?.metadata?.name ? String(document.metadata.name) : 'None'
}

function errorText(error) {
  if (typeof error === 'string') return error
  if (error && typeof error === 'object') {
    const path = error.path ? `${error.path}: ` : ''
    return `${path}${error.message || error.error || JSON.stringify(error)}`
  }
  return String(error)
}

export function mount(
  api,
  { isRunning = () => false, restart = async () => {}, chatSupported = true, onApplied = () => {} } = {},
) {
  const $ = (id) => document.getElementById(id)
  const modal = $('workerStudioModal')
  if (!modal) return null

  let state = { draft: null, active: null, previous: null }
  let draft = null
  let opener = null
  let dirty = false
  let latestMatchedRuleId = null
  const traceHistory = []

  function setStatus(message, tone = '') {
    $('workerStudioStatus').textContent = message || ''
    $('workerStudioStatus').dataset.tone = tone
  }

  function setDirty(value) {
    dirty = value
    $('workerStudioDirty').hidden = !value
  }

  function paintVersionStatus() {
    $('workerDraftStatus').textContent = workerName(draft || state.draft)
    $('workerActiveStatus').textContent = workerName(state.active)
    $('workerPreviousStatus').textContent = workerName(state.previous)
    $('workerRollback').disabled = !state.previous
    $('workerExport').disabled = !state.active
  }

  function renderValidation(errors = [], successMessage = '') {
    const box = $('workerValidation')
    box.textContent = ''
    box.dataset.tone = errors.length ? 'error' : 'valid'
    if (!errors.length) {
      if (successMessage) box.appendChild(node('p', 'worker-valid', successMessage))
      return
    }
    const list = node('ul', 'worker-error-list')
    for (const error of errors) list.appendChild(node('li', '', errorText(error)))
    box.appendChild(list)
  }

  function renderRules() {
    const box = $('workerRules')
    box.textContent = ''
    const rules = orderedRules(draft)
    $('workerRuleCount').textContent = `${rules.length} rule${rules.length === 1 ? '' : 's'} · high priority first`
    if (!rules.length) {
      box.appendChild(node('p', 'empty', 'No rules in this draft.'))
      return
    }
    for (const [index, rule] of rules.entries()) {
      const card = node('article', 'worker-rule-card')
      if (String(rule.id) === String(latestMatchedRuleId)) card.classList.add('matched')
      const header = node('div', 'worker-rule-title')
      header.append(
        node('strong', 'worker-rule-id', rule.id || 'Unnamed rule'),
        node('span', 'worker-priority', `Priority ${rule.priority ?? 0}`),
      )
      const condition = node('p', 'worker-condition', conditionSummary(rule.condition))
      const actions = node('ul', 'worker-actions')
      for (const action of Array.isArray(rule.actions) ? rule.actions : []) {
        actions.appendChild(node('li', '', actionSummary(action)))
      }
      card.append(header, condition, actions)
      box.appendChild(card)
      if (index < rules.length - 1) box.appendChild(node('div', 'worker-rule-link', '↓ otherwise'))
    }
  }

  function setDocument(document, { changed = true } = {}) {
    draft = document
    $('workerJson').value = JSON.stringify(document, null, 2)
    setDirty(changed)
    paintVersionStatus()
    renderValidation()
    renderRules()
  }

  function parsedDocument() {
    try {
      const parsed = JSON.parse($('workerJson').value)
      draft = parsed
      return parsed
    } catch (error) {
      renderValidation([{ path: '/', message: `Invalid JSON: ${error.message}` }])
      setStatus('Fix the JSON syntax before continuing.', 'error')
      return null
    }
  }

  function applyState(nextState, options = {}) {
    if (!nextState) return
    state = nextState
    setDocument(nextState.draft, options)
  }

  async function open() {
    opener = document.activeElement
    modal.hidden = false
    setStatus('Loading worker draft…')
    const result = await api.getWorkerState()
    if (!result?.ok) {
      setStatus(result?.error || 'Could not load Worker Studio.', 'error')
    } else {
      state = result.state
      if (!dirty) setDocument(state.draft, { changed: false })
      else paintVersionStatus()
      setStatus('Draft changes never activate until you choose Apply.')
    }
    $('workerJson').focus()
  }

  function close() {
    modal.hidden = true
    if (opener?.focus) opener.focus()
    opener = null
  }

  async function validate() {
    const document = parsedDocument()
    if (!document) return false
    const result = await api.validateWorker(document)
    const errors = result?.errors || (result?.ok ? [] : [result?.error || 'Validation failed'])
    renderValidation(errors, 'Valid worker document.')
    setStatus(result?.ok ? 'Validation passed. The draft is still inactive.' : 'Validation found errors.', result?.ok ? 'valid' : 'error')
    return Boolean(result?.ok)
  }

  async function saveDraft() {
    const document = parsedDocument()
    if (!document) return
    const result = await api.saveWorkerDraft(document)
    if (!result?.ok) {
      renderValidation(result?.errors || [result?.error || 'Could not save draft'])
      setStatus(result?.error || 'Could not save draft.', 'error')
      return
    }
    applyState(result.state, { changed: false })
    setStatus('Draft saved. Active worker is unchanged.', 'valid')
  }

  function appendChat(role, message) {
    const item = node('div', `worker-chat-message ${role}`)
    item.append(node('strong', '', role === 'user' ? 'You' : 'Assistant'), node('p', '', message))
    $('workerChat').appendChild(item)
    $('workerChat').scrollTop = $('workerChat').scrollHeight
  }

  /// The chat needs an OpenAI-compatible endpoint to send the patch request
  /// to; a CLI backend has none, so say so instead of failing per keystroke.
  function disableChat(reason) {
    $('workerChatSend').disabled = true
    $('workerChatMessage').disabled = true
    $('workerChatHint').textContent = reason
  }

  async function customize() {
    if (!chatSupported) return
    const message = $('workerChatMessage').value.trim()
    const document = parsedDocument()
    if (!message || !document) return
    appendChat('user', message)
    $('workerChatMessage').value = ''
    $('workerChatSend').disabled = true
    $('workerChatHint').textContent = 'Asking the configured LLM…'
    const result = await api.customizeWorker({ document, message })
    $('workerChatSend').disabled = false
    if (!result?.ok) {
      const message = result?.error || 'Customization failed.'
      appendChat('assistant', message)
      $('workerChatHint').textContent = message
      if (result?.unsupported || /requires a configured|is not configured/i.test(message)) {
        disableChat(`Chat customization unavailable: ${message}`)
      }
      renderValidation(result?.errors || [])
      return
    }
    const updated = result.document || result.draft || result.state?.draft
    if (result.state) state = result.state
    if (updated) setDocument(updated, { changed: !result.state })
    appendChat('assistant', result.summary || 'Updated the draft. Review it before applying.')
    $('workerChatHint').textContent = result.state
      ? 'Customized draft saved. Apply explicitly when ready.'
      : 'Customized draft is not saved or active yet.'
  }

  function matchedId(result) {
    return result?.matchedRuleId ?? result?.matched_rule_id ?? result?.ruleId ?? null
  }

  function renderEvaluation(container, result, fallbackName = 'Snapshot') {
    const card = node('article', 'worker-result-card')
    card.appendChild(node('strong', '', result?.name || fallbackName))
    const match = matchedId(result)
    card.appendChild(node('p', match ? 'worker-match' : 'worker-skip', match ? `Matched: ${match}` : 'No rule matched'))
    const trace = Array.isArray(result?.trace) ? result.trace : []
    if (trace.length) {
      const traceList = node('ul', 'worker-eval-trace')
      for (const step of trace) {
        const label = `${step.matched ? '✓ matched' : '– skipped'} ${step.ruleId ?? step.rule_id ?? 'rule'} (priority ${step.priority ?? '—'})`
        traceList.appendChild(node('li', step.matched ? 'matched' : '', label))
      }
      card.appendChild(traceList)
    }
    const actions = Array.isArray(result?.actions) ? result.actions : []
    if (actions.length) {
      const list = node('ul', 'worker-actions')
      for (const action of actions) list.appendChild(node('li', '', actionSummary(action)))
      card.appendChild(list)
    }
    container.appendChild(card)
    return match
  }

  async function simulate() {
    const document = parsedDocument()
    if (!document) return
    // Empty means "against whatever the agent is looking at right now": main
    // answers from the last live state body rather than a written-out scenario.
    const written = $('workerSnapshots').value.trim()
    let snapshots
    if (written) {
      try {
        snapshots = JSON.parse(written)
        if (!Array.isArray(snapshots)) throw new Error('Expected a JSON array')
      } catch (error) {
        setStatus(`Simulator input is invalid: ${error.message}`, 'error')
        return
      }
    }
    $('workerSimulate').disabled = true
    const result = await api.simulateWorker(snapshots ? { document, snapshots } : { document })
    $('workerSimulate').disabled = false
    const box = $('workerSimulation')
    box.textContent = ''
    if (!result?.ok) {
      box.appendChild(node('p', 'worker-error', result?.error || 'Simulation failed.'))
      setStatus(result?.error || 'Simulation failed.', 'error')
      return
    }
    const results = result.results || []
    latestMatchedRuleId = null
    for (const evaluation of results) latestMatchedRuleId = renderEvaluation(box, evaluation) || latestMatchedRuleId
    renderRules()
    setStatus(
      snapshots
        ? `Simulated ${results.length} named snapshot${results.length === 1 ? '' : 's'}.`
        : 'Simulated against the live agent state.',
      'valid',
    )
  }

  function appendTrace(payload) {
    const entries = normalizeTrace(payload)
    if (!entries.length) return
    for (const entry of entries) {
      cappedAppend(traceHistory, entry)
      latestMatchedRuleId = entry.matchedRuleId || latestMatchedRuleId
    }
    const box = $('workerTrace')
    box.textContent = ''
    for (const entry of traceHistory) {
      const card = node('article', 'worker-trace-entry')
      card.appendChild(node('time', '', new Date(entry.timestamp).toLocaleTimeString()))
      if (entry.matchedRuleId) card.appendChild(node('p', 'worker-match', `Matched: ${entry.matchedRuleId}`))
      const list = node('ul', 'worker-actions')
      if (entry.actions.length) {
        for (const action of entry.actions) list.appendChild(node('li', '', actionSummary(action)))
      } else {
        list.appendChild(node('li', 'empty', entry.note || 'No actions this turn.'))
      }
      card.appendChild(list)
      box.appendChild(card)
    }
    box.scrollTop = box.scrollHeight
    if (!modal.hidden) renderRules()
  }

  async function apply() {
    const document = parsedDocument()
    if (!document) return
    $('workerApply').disabled = true
    const result = await api.applyWorker(document)
    $('workerApply').disabled = false
    if (!result?.ok) {
      renderValidation(result?.errors || [result?.error || 'Could not apply worker'])
      setStatus(result?.error || 'Could not apply worker.', 'error')
      return
    }
    applyState(result.state, { changed: false })
    onApplied(result.settings)
    if (isRunning()) {
      setStatus('Worker applied. Restarting the running agent…')
      try {
        await restart()
      } catch (error) {
        setStatus(`Worker applied, but restart failed: ${error.message}`, 'error')
        return
      }
    }
    setStatus(isRunning() ? 'Worker applied and agent restarted.' : 'Worker applied. It will run on the next start.', 'valid')
  }

  async function rollback() {
    const result = await api.rollbackWorker()
    if (!result?.ok) {
      setStatus(result?.error || 'Could not roll back.', 'error')
      return
    }
    applyState(result.state, { changed: false })
    setStatus('Previous worker restored. Restart the agent to use it in this session.', 'valid')
  }

  async function importDraft() {
    const result = await api.importWorker()
    if (result?.canceled) {
      setStatus('Import canceled. Nothing changed.')
      return
    }
    if (!result?.ok) {
      setStatus(result?.error || 'Could not import worker.', 'error')
      return
    }
    const imported = result.document || result.draft || result.state?.draft
    if (result.state) state = result.state
    if (imported) setDocument(imported, { changed: !result.state })
    setStatus('Imported into the draft. Active worker is unchanged.', 'valid')
  }

  async function exportActive() {
    const result = await api.exportWorker()
    if (result?.canceled) setStatus('Export canceled. Nothing changed.')
    else if (result?.ok) setStatus(`Exported active worker${result.file ? ` to ${result.file}` : ''}.`, 'valid')
    else setStatus(result?.error || 'Could not export worker.', 'error')
  }

  $('workerStudioOpen').addEventListener('click', () => void open())
  $('workerStudioClose').addEventListener('click', close)
  $('workerJson').addEventListener('input', () => {
    setDirty(true)
    const parsed = parsedDocument()
    if (parsed) {
      renderValidation()
      renderRules()
      paintVersionStatus()
      setStatus('Draft-only edit. Validate, save, or apply when ready.')
    }
  })
  $('workerValidate').addEventListener('click', () => void validate())
  $('workerSave').addEventListener('click', () => void saveDraft())
  $('workerApply').addEventListener('click', () => void apply())
  $('workerRollback').addEventListener('click', () => void rollback())
  $('workerImport').addEventListener('click', () => void importDraft())
  $('workerExport').addEventListener('click', () => void exportActive())
  $('workerOpenFolder').addEventListener('click', async () => {
    const result = await api.openWorkerFolder()
    setStatus(result?.ok ? 'Opened the worker folder.' : result?.error || 'Could not open the worker folder.', result?.ok ? 'valid' : 'error')
  })
  $('workerChatSend').addEventListener('click', () => void customize())
  $('workerSimulate').addEventListener('click', () => void simulate())
  $('workerTraceClear').addEventListener('click', () => {
    traceHistory.length = 0
    $('workerTrace').textContent = ''
  })
  modal.addEventListener('mousedown', (event) => {
    if (event.target === modal) close()
  })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !modal.hidden) close()
  })

  $('workerSnapshots').value = JSON.stringify(DEFAULT_SNAPSHOTS, null, 2)
  if (!chatSupported) {
    disableChat('Chat customization needs an OpenAI-compatible HTTP backend — pick one under Settings › LLM.')
  }
  api.onWorkerTrace(appendTrace)

  return { open, close, appendTrace }
}
