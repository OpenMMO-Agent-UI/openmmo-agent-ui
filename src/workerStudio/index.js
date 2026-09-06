'use strict'

const FORMAT = 'openmmo-worker'
const VERSION = 1
const ACTIONS = new Set(['attack', 'move', 'use', 'buy', 'sell', 'drop', 'pickup', 'fish', 'say', 'wait'])
const INTENTS = new Set(['patrol', 'flee', 'return_to_anchor'])
const COLLECTIONS = new Set(['bag', 'monsters', 'players', 'ground_items'])
const OPERATORS = new Set(['all', 'any', 'not', 'eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'exists'])
const REF_FIELDS = {
  self: new Set(['id', 'name', 'health', 'max_health', 'health_pct', 'mana', 'max_mana', 'mana_pct', 'level', 'gold', 'position', 'x', 'y']),
  monster: new Set(['id', 'name', 'kind', 'health', 'max_health', 'health_pct', 'level', 'position', 'x', 'y', 'distance', 'aggressive']),
  item: new Set(['id', 'name', 'count', 'quantity', 'slot', 'type', 'value']),
  player: new Set(['id', 'name', 'health', 'max_health', 'health_pct', 'level', 'position', 'x', 'y', 'distance']),
  ground_item: new Set(['id', 'item', 'name', 'quantity', 'position', 'x', 'y', 'distance']),
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function createDocument() {
  return {
    format: FORMAT,
    version: VERSION,
    metadata: { name: 'Untitled Worker', description: '' },
    rules: [],
  }
}

function normalizeDocument(input) {
  const source = clone(input || {})
  const document = createDocument()
  document.format = source.format ?? document.format
  document.version = source.version ?? document.version
  const metadata = source.metadata && typeof source.metadata === 'object' && !Array.isArray(source.metadata)
    ? source.metadata
    : {}
  document.metadata = { ...document.metadata, ...metadata }
  document.rules = Array.isArray(source.rules) ? source.rules : []
  return document
}

function validateDocument(document) {
  const errors = []
  const error = (path, message) => errors.push({ path, message })
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    return [{ path: '', message: 'document must be an object' }]
  }
  if (document.format !== FORMAT) error('/format', `must be ${FORMAT}`)
  if (document.version !== VERSION) error('/version', `must be ${VERSION}`)
  if (!document.metadata || typeof document.metadata !== 'object' || Array.isArray(document.metadata)) {
    error('/metadata', 'must be an object')
  } else {
    if (typeof document.metadata.name !== 'string' || !document.metadata.name.trim()) error('/metadata/name', 'must be a non-empty string')
    if (document.metadata.description !== undefined && typeof document.metadata.description !== 'string') error('/metadata/description', 'must be a string')
  }
  if (!Array.isArray(document.rules)) {
    error('/rules', 'must be an array')
    return errors
  }

  const ids = new Set()
  document.rules.forEach((rule, index) => {
    const path = `/rules/${index}`
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
      error(path, 'must be an object')
      return
    }
    if (typeof rule.id !== 'string' || !rule.id.trim()) error(`${path}/id`, 'must be a non-empty string')
    else if (ids.has(rule.id)) error(`${path}/id`, `duplicate rule id ${rule.id}`)
    else ids.add(rule.id)
    if (!Number.isInteger(rule.priority)) error(`${path}/priority`, 'must be an integer')
    validateCondition(rule.condition, `${path}/condition`, error)
    if (!Array.isArray(rule.actions) || rule.actions.length === 0) error(`${path}/actions`, 'must be a non-empty array')
    else rule.actions.forEach((action, actionIndex) => validateAction(action, `${path}/actions/${actionIndex}`, error))
  })
  return errors
}

function validateCondition(condition, path, error) {
  if (!condition || typeof condition !== 'object' || Array.isArray(condition)) {
    error(path, 'must be a structured condition object')
    return
  }
  const keys = Object.keys(condition)
  if (keys.length !== 1 || !OPERATORS.has(keys[0])) {
    error(path, `unknown condition operator ${keys[0] || '(none)'}`)
    return
  }
  const operator = keys[0]
  const value = condition[operator]
  if (operator === 'all' || operator === 'any') {
    if (!Array.isArray(value) || value.length === 0) error(`${path}/${operator}`, 'must be a non-empty array')
    else value.forEach((child, index) => validateCondition(child, `${path}/${operator}/${index}`, error))
  } else if (operator === 'not') {
    validateCondition(value, `${path}/not`, error)
  } else if (operator === 'exists') {
    if (value && typeof value === 'object' && value.select !== undefined) validateSelector(value, `${path}/exists`, error)
    else validateOperand(value, `${path}/exists`, error)
  } else if (!Array.isArray(value) || value.length !== 2) {
    error(`${path}/${operator}`, 'must contain two operands')
  } else {
    value.forEach((operand, index) => validateOperand(operand, `${path}/${operator}/${index}`, error))
  }
}

function validateOperand(operand, path, error) {
  if (operand === null || ['string', 'number', 'boolean'].includes(typeof operand)) return
  if (!operand || typeof operand !== 'object' || Array.isArray(operand)) {
    error(path, 'must be a literal, ref, or count operand')
    return
  }
  if (Object.keys(operand).length === 1 && typeof operand.ref === 'string') {
    const [scope, ...fieldParts] = operand.ref.split('.')
    const field = fieldParts.join('.')
    if (!REF_FIELDS[scope]?.has(field)) error(`${path}/ref`, `unknown ref ${operand.ref}`)
    return
  }
  if (Object.keys(operand).length === 1 && operand.count && typeof operand.count === 'object') {
    validateSelector(operand.count, `${path}/count`, error)
    return
  }
  error(path, 'must be a literal, ref, or count operand')
}

function validateSelector(selector, path, error) {
  if (!selector || typeof selector !== 'object' || Array.isArray(selector)) {
    error(path, 'must be a selector object')
    return
  }
  if (!COLLECTIONS.has(selector.select)) error(`${path}/select`, `unknown collection ${selector.select}`)
  if (selector.where !== undefined) validateCondition(selector.where, `${path}/where`, error)
}

function validateAction(action, path, error) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) {
    error(path, 'must be an action object')
    return
  }
  const hasAction = typeof action.action === 'string'
  const hasIntent = typeof action.intent === 'string'
  if (hasAction && hasIntent) {
    error(path, 'must specify exactly one of action or intent')
  } else if (hasAction) {
    if (!ACTIONS.has(action.action)) error(`${path}/action`, `unknown action ${action.action}`)
  } else if (hasIntent) {
    if (!INTENTS.has(action.intent)) error(`${path}/intent`, `unknown intent ${action.intent}`)
  } else {
    error(path, 'must specify action or intent')
  }
  for (const [key, value] of Object.entries(action)) {
    if (key !== 'action' && key !== 'intent' && value && typeof value === 'object' && value.select !== undefined) {
      validateSelector(value, `${path}/${key}`, error)
    }
  }
}

function evaluateDocument(document, snapshot) {
  const errors = validateDocument(document)
  if (errors.length) {
    const failure = new Error(`invalid worker document: ${errors[0].path} ${errors[0].message}`)
    failure.errors = errors
    throw failure
  }
  const rules = document.rules.map((rule, index) => ({ rule, index }))
    .sort((left, right) => right.rule.priority - left.rule.priority || left.index - right.index)
  const trace = []
  for (const { rule } of rules) {
    const matched = evaluateCondition(rule.condition, snapshot, {})
    trace.push({ ruleId: rule.id, priority: rule.priority, matched })
    if (matched) {
      return {
        matchedRuleId: rule.id,
        actions: rule.actions.map((action) => resolveValue(action, snapshot, {})),
        trace,
      }
    }
  }
  return { matchedRuleId: null, actions: [], trace }
}

function evaluateCondition(condition, snapshot, context) {
  const operator = Object.keys(condition)[0]
  const value = condition[operator]
  if (operator === 'all') return value.every((child) => evaluateCondition(child, snapshot, context))
  if (operator === 'any') return value.some((child) => evaluateCondition(child, snapshot, context))
  if (operator === 'not') return !evaluateCondition(value, snapshot, context)
  if (operator === 'exists') {
    if (value && typeof value === 'object' && value.select !== undefined) return selectItems(value, snapshot).length > 0
    const resolved = resolveOperand(value, snapshot, context)
    return resolved !== undefined && resolved !== null
  }
  const left = resolveOperand(value[0], snapshot, context)
  const right = resolveOperand(value[1], snapshot, context)
  if (operator === 'eq') return left === right
  if (operator === 'ne') return left !== right
  if (operator === 'lt') return left < right
  if (operator === 'lte') return left <= right
  if (operator === 'gt') return left > right
  if (operator === 'gte') return left >= right
  return false
}

function resolveOperand(operand, snapshot, context) {
  if (!operand || typeof operand !== 'object') return operand
  if (operand.ref) {
    const [scope, ...parts] = operand.ref.split('.')
    let value = scope === 'self' ? snapshot.self : context[scope]
    for (const part of parts) value = value == null ? undefined : value[part]
    return value
  }
  if (operand.count) return selectItems(operand.count, snapshot).length
  return undefined
}

function selectItems(selector, snapshot) {
  const items = Array.isArray(snapshot[selector.select]) ? snapshot[selector.select] : []
  const scope = { bag: 'item', monsters: 'monster', players: 'player', ground_items: 'ground_item' }[selector.select]
  const selected = selector.where
    ? items.filter((item) => evaluateCondition(selector.where, snapshot, { [scope]: item }))
    : items.slice()
  if (selector.order === 'nearest' || (selector.order === undefined && selector.select !== 'bag')) {
    selected.sort((left, right) => distanceToSelf(left, snapshot.self) - distanceToSelf(right, snapshot.self))
  }
  return selected
}

function distanceToSelf(entity, self) {
  if (Number.isFinite(entity.distance)) return entity.distance
  const a = entity.position || entity
  const b = self?.position || self || {}
  if (![a.x, a.y, b.x, b.y].every(Number.isFinite)) return Number.POSITIVE_INFINITY
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function resolveValue(value, snapshot, context) {
  if (Array.isArray(value)) return value.map((entry) => resolveValue(entry, snapshot, context))
  if (!value || typeof value !== 'object') return value
  if (value.select !== undefined) return clone(selectItems(value, snapshot)[0] ?? null)
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, resolveValue(entry, snapshot, context)]))
}

function simulateDocument(document, scenarios) {
  if (!Array.isArray(scenarios)) throw new TypeError('scenarios must be an array')
  return scenarios.map((scenario, index) => {
    if (!scenario || typeof scenario.name !== 'string' || !scenario.name) throw new TypeError(`scenario ${index} must have a name`)
    return { name: scenario.name, ...evaluateDocument(document, scenario.snapshot || {}) }
  })
}

/// agent-client's `/api/state` body speaks the server's own vocabulary
/// (`monster_type`, `item_def_id`, no percentages or distances); a document's
/// refs speak the one template.rs resolves. Bridge the two, or a simulation
/// against live state silently reports that nothing matched.
function snapshotFromState(body) {
  const source = body && typeof body === 'object' ? body : {}
  const me = source.self && typeof source.self === 'object' ? source.self : null
  // The runtime measures on the ground plane (x/z); the evaluator's fallback
  // reads x/y, so z is carried as y and distance is precomputed either way.
  const at = (entity) => {
    const position = (entity && entity.position) || entity || {}
    return Number.isFinite(position.x) && Number.isFinite(position.z)
      ? { x: position.x, y: position.z }
      : {}
  }
  const here = at(me)
  const away = (entity) => {
    const there = at(entity)
    if (!Number.isFinite(here.x) || !Number.isFinite(there.x)) return undefined
    return Math.hypot(there.x - here.x, there.y - here.y)
  }
  const list = (key) => (Array.isArray(source[key]) ? source[key] : [])
  const vitals = (entity) => ({
    health: entity.health,
    max_health: entity.max_health,
    health_pct: percent(entity.health, entity.max_health),
  })
  return {
    self: me && { id: me.id, name: me.name, level: me.level, gold: source.gold ?? null, position: here, ...vitals(me) },
    monsters: list('monsters').map((monster) => ({
      id: monster.id,
      name: monster.monster_type,
      kind: monster.monster_type,
      // The runtime reads a monster's level from its definition table, which
      // the state body does not carry; only a dungeon override is knowable.
      level: monster.level_override ?? null,
      aggressive: monster.aggressive === true,
      position: at(monster),
      distance: away(monster),
      ...vitals(monster),
    })),
    players: list('players').map((player) => ({
      id: player.id,
      name: player.name,
      level: player.level,
      position: at(player),
      distance: away(player),
      ...vitals(player),
    })),
    bag: list('bag').map((item) => ({
      id: item.item_def_id,
      name: item.item_def_id,
      count: item.quantity,
      quantity: item.quantity,
    })),
    ground_items: list('ground_items').map((item) => ({
      id: item.instance_id ?? null,
      item: item.item,
      name: item.item,
      position: at(item),
      distance: away(item),
    })),
  }
}

/// Integer percent, floored, matching template.rs's saturating arithmetic.
function percent(value, maximum) {
  if (!Number.isFinite(value) || !Number.isFinite(maximum) || maximum <= 0) return 0
  return Math.floor((value * 100) / maximum)
}

const { applyJsonPatch } = require('./jsonPatch')
const portable = require('./portable')

function portableDocument(input) {
  const document = portable.portableDocument(input)
  const errors = validateDocument(document)
  if (errors.length) {
    const error = new Error(`invalid portable worker: ${errors[0].path} ${errors[0].message}`)
    error.errors = errors
    throw error
  }
  return document
}

function exportPortableDocument(input) {
  return portable.exportPortableDocument(input, validateDocument)
}

function importPortableDocument(input) {
  return portable.importPortableDocument(input, validateDocument)
}

module.exports = {
  FORMAT, VERSION, createDocument, normalizeDocument, validateDocument,
  evaluateDocument, simulateDocument, snapshotFromState, applyJsonPatch,
  portableDocument, exportPortableDocument, importPortableDocument,
}
