'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const studioPromise = import('../src/workerStudio/index.js')

test('createDocument and normalizeDocument produce independent version 1 documents', async () => {
  const { createDocument, normalizeDocument } = await studioPromise
  const created = createDocument()
  assert.deepEqual(created, {
    format: 'openmmo-worker',
    version: 1,
    metadata: { name: 'Untitled Worker', description: '' },
    rules: [],
  })

  const source = { format: 'openmmo-worker', version: 1, metadata: { name: 'Hunter' }, rules: [] }
  const normalized = normalizeDocument(source)
  normalized.metadata.name = 'Changed'
  assert.equal(source.metadata.name, 'Hunter')
  assert.equal(normalized.metadata.description, '')
})

test('normalizeDocument replaces malformed optional containers with defaults', async () => {
  const { normalizeDocument } = await studioPromise
  assert.deepEqual(normalizeDocument({ metadata: 'not-an-object', rules: {} }), {
    format: 'openmmo-worker',
    version: 1,
    metadata: { name: 'Untitled Worker', description: '' },
    rules: [],
  })
})

test('validateDocument accepts the supported condition, action, and intent vocabulary', async () => {
  const { validateDocument } = await studioPromise
  const document = {
    format: 'openmmo-worker',
    version: 1,
    metadata: { name: 'Slime hunter', description: 'Safe example' },
    rules: [
      {
        id: 'heal',
        priority: 100,
        condition: {
          all: [
            { lt: [{ ref: 'self.health_pct' }, 30] },
            { exists: { ref: 'self.position' } },
            { gt: [{ count: { select: 'bag', where: { eq: [{ ref: 'item.name' }, 'Potion'] } } }, 0] },
          ],
        },
        actions: [{ action: 'use', item: { select: 'bag', where: { eq: [{ ref: 'item.name' }, 'Potion'] } } }],
      },
      {
        id: 'hunt',
        priority: 10,
        condition: { any: [{ ne: [{ ref: 'self.health' }, 0] }, { not: { eq: [true, false] } }] },
        actions: [{ intent: 'patrol' }, { action: 'wait', duration_ms: 100 }],
      },
    ],
  }

  assert.deepEqual(validateDocument(document), [])
})

test('validateDocument accepts selector existence and runtime field aliases', async () => {
  const { validateDocument } = await studioPromise
  const document = {
    format: 'openmmo-worker', version: 1, metadata: { name: 'Aliases', description: '' },
    rules: [{
      id: 'aliases', priority: 1,
      condition: {
        all: [
          { exists: { select: 'ground_items', where: { eq: [{ ref: 'ground_item.item' }, 'coin'] } } },
          { gte: [{ ref: 'self.gold' }, 0] },
          { eq: [{ ref: 'monster.kind' }, 'Slime'] },
          { gt: [{ ref: 'item.count' }, 0] },
        ],
      },
      actions: [{ action: 'pickup' }],
    }],
  }

  assert.deepEqual(validateDocument(document), [])
})

test('validateDocument reports path-specific errors for invalid documents', async () => {
  const { validateDocument } = await studioPromise
  const errors = validateDocument({
    format: 'other',
    version: 2,
    metadata: { name: '', description: 7 },
    rules: [
      { id: 'same', priority: 1.5, condition: 'unsafe', actions: [{ action: 'dance' }] },
      { id: 'same', priority: 1, condition: { xor: [true, false] }, actions: [{ intent: 'sleep' }] },
      { id: 'ref', priority: 0, condition: { eq: [{ ref: 'self.api_key' }, true] }, actions: [{ action: 'wait' }] },
      { id: 'ambiguous', priority: -1, condition: { eq: [1, 1] }, actions: [{ action: 'wait', intent: 'flee' }] },
    ],
  })
  const paths = errors.map((error) => error.path)

  for (const path of [
    '/format', '/version', '/metadata/name', '/metadata/description',
    '/rules/0/priority', '/rules/0/condition', '/rules/0/actions/0/action',
    '/rules/1/id', '/rules/1/condition', '/rules/1/actions/0/intent',
    '/rules/2/condition/eq/0/ref', '/rules/3/actions/0',
  ]) assert.ok(paths.includes(path), `missing ${path}`)
})

test('evaluateDocument picks the highest-priority match and resolves the nearest target', async () => {
  const { evaluateDocument } = await studioPromise
  const document = {
    format: 'openmmo-worker', version: 1, metadata: { name: 'Hunter', description: '' },
    rules: [
      { id: 'flee', priority: 100, condition: { lt: [{ ref: 'self.health_pct' }, 20] }, actions: [{ intent: 'flee' }] },
      {
        id: 'attack-slime', priority: 50,
        condition: { gt: [{ count: { select: 'monsters', where: { eq: [{ ref: 'monster.name' }, 'Slime'] } } }, 0] },
        actions: [{ action: 'attack', target: { select: 'monsters', where: { eq: [{ ref: 'monster.name' }, 'Slime'] }, order: 'nearest' } }],
      },
      { id: 'idle', priority: 0, condition: { eq: [true, true] }, actions: [{ action: 'wait', duration_ms: 1000 }] },
    ],
  }
  const snapshot = {
    self: { health_pct: 80, position: { x: 0, y: 0 } },
    monsters: [
      { id: 9, name: 'Slime', position: { x: 5, y: 0 } },
      { id: 3, name: 'Slime', position: { x: 2, y: 0 } },
      { id: 1, name: 'Bat', position: { x: 1, y: 0 } },
    ],
  }

  assert.deepEqual(evaluateDocument(document, snapshot), {
    matchedRuleId: 'attack-slime',
    actions: [{ action: 'attack', target: { id: 3, name: 'Slime', position: { x: 2, y: 0 } } }],
    trace: [
      { ruleId: 'flee', priority: 100, matched: false },
      { ruleId: 'attack-slime', priority: 50, matched: true },
    ],
  })
})

test('simulateDocument returns deterministic results for every named snapshot', async () => {
  const { simulateDocument } = await studioPromise
  const document = {
    format: 'openmmo-worker', version: 1, metadata: { name: 'Survivor', description: '' },
    rules: [
      { id: 'flee', priority: 10, condition: { lte: [{ ref: 'self.health_pct' }, 25] }, actions: [{ intent: 'flee' }] },
      { id: 'wait', priority: 0, condition: { eq: [true, true] }, actions: [{ action: 'wait', duration_ms: 10 }] },
    ],
  }

  const result = simulateDocument(document, [
    { name: 'hurt', snapshot: { self: { health_pct: 10 } } },
    { name: 'healthy', snapshot: { self: { health_pct: 90 } } },
  ])

  assert.deepEqual(result.map(({ name, matchedRuleId, actions }) => ({ name, matchedRuleId, actions })), [
    { name: 'hurt', matchedRuleId: 'flee', actions: [{ intent: 'flee' }] },
    { name: 'healthy', matchedRuleId: 'wait', actions: [{ action: 'wait', duration_ms: 10 }] },
  ])
})

test('applyJsonPatch applies add, replace, and remove to a clone', async () => {
  const { applyJsonPatch } = await studioPromise
  const source = { metadata: { name: 'Old' }, rules: [{ id: 'one' }] }
  const result = applyJsonPatch(source, [
    { op: 'replace', path: '/metadata/name', value: 'New' },
    { op: 'add', path: '/rules/-', value: { id: 'two' } },
    { op: 'remove', path: '/rules/0' },
  ])

  assert.deepEqual(result, { metadata: { name: 'New' }, rules: [{ id: 'two' }] })
  assert.deepEqual(source, { metadata: { name: 'Old' }, rules: [{ id: 'one' }] })
})

test('applyJsonPatch rejects unsafe paths, invalid indices, and missing values', async () => {
  const { applyJsonPatch } = await studioPromise
  for (const patch of [
    [{ op: 'add', path: '/__proto__/polluted', value: true }],
    [{ op: 'replace', path: '/rules/01', value: {} }],
    [{ op: 'remove', path: '/rules/-' }],
    [{ op: 'add', path: '/metadata/name' }],
  ]) assert.throws(() => applyJsonPatch({ metadata: {}, rules: [] }, patch))
  assert.equal({}.polluted, undefined)
})

test('portable helpers whitelist spec fields, strip secrets and paths, and emit deterministic JSON', async () => {
  const { exportPortableDocument, importPortableDocument } = await studioPromise
  const source = {
    format: 'openmmo-worker', version: 1,
    metadata: { description: 'Share me', name: 'Portable', apiKey: 'sk-private' },
    rules: [{
      id: 'speak', priority: 1, condition: { eq: [true, true] },
      actions: [{ action: 'say', text: 'hello', memory: ['private'], options: { token: 'secret', label: 'public' } }],
      snapshots: [{ private: true }],
    }],
    workspace: '/Users/alice/private',
  }

  const first = exportPortableDocument(source)
  const second = exportPortableDocument(source)
  assert.equal(first, second)
  assert.ok(first.endsWith('\n'))
  assert.deepEqual(JSON.parse(first), {
    format: 'openmmo-worker',
    metadata: { description: 'Share me', name: 'Portable' },
    rules: [{
      actions: [{ action: 'say', options: { label: 'public' }, text: 'hello' }],
      condition: { eq: [true, true] }, id: 'speak', priority: 1,
    }],
    version: 1,
  })
  assert.deepEqual(importPortableDocument(first), JSON.parse(first))
})

test('the portable fixture validates and the JSON Schema describes version 1', async () => {
  const { validateDocument } = await studioPromise
  const root = path.join(__dirname, '..')
  const fixture = JSON.parse(fs.readFileSync(path.join(root, 'worker-api/examples/slime-hunter.ommoworker.json'), 'utf8'))
  const schema = JSON.parse(fs.readFileSync(path.join(root, 'worker-api/schema.json'), 'utf8'))

  assert.deepEqual(validateDocument(fixture), [])
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema')
  assert.equal(schema.properties.format.const, 'openmmo-worker')
  assert.equal(schema.properties.version.const, 1)
  assert.ok(schema.$defs.condition)
  assert.ok(schema.$defs.action)
})

test('snapshotFromState turns a live agent state body into the ref vocabulary', async () => {
  const { snapshotFromState } = await studioPromise
  const snapshot = snapshotFromState({
    gold: 12,
    self: { id: 'p1', name: 'Me', level: 4, health: 80, max_health: 100, position: { x: 0, y: 1.2, z: 0 } },
    monsters: [
      { id: 'far', monster_type: 'Slime', health: 5, max_health: 20, position: { x: 0, y: 0, z: 9 }, aggressive: true },
      { id: 'near', monster_type: 'Slime', health: 20, max_health: 20, position: { x: 3, y: 0, z: 0 } },
    ],
    bag: [{ instance_id: 7, item_def_id: 'Health Potion', quantity: 2 }],
    ground_items: [{ x: 0, z: 4, item: 'copper_coin' }],
  })

  assert.equal(snapshot.self.health_pct, 80, 'percentages are derived, as template.rs derives them')
  assert.equal(snapshot.self.gold, 12, 'gold sits beside self, not inside it, in the state body')
  assert.deepEqual(snapshot.self.position, { x: 0, y: 0 }, 'the ground plane is x/z, carried as x/y')
  assert.equal(snapshot.monsters[0].name, 'Slime', 'monster_type is what monster.name resolves to')
  assert.equal(snapshot.monsters[0].health_pct, 25)
  assert.equal(snapshot.monsters[0].distance, 9)
  assert.equal(snapshot.monsters[1].distance, 3)
  assert.equal(snapshot.monsters[0].aggressive, true)
  assert.equal(snapshot.monsters[1].aggressive, false)
  assert.deepEqual(snapshot.bag, [{ id: 'Health Potion', name: 'Health Potion', count: 2, quantity: 2 }])
  assert.equal(snapshot.ground_items[0].name, 'copper_coin')
  assert.equal(snapshot.ground_items[0].distance, 4)
})

test('a live state body decides the same rule the running worker would', async () => {
  const { snapshotFromState, evaluateDocument } = await studioPromise
  const document = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'worker-api/examples/slime-hunter.ommoworker.json'), 'utf8'),
  )
  const body = (health) => ({
    self: { id: 'p1', name: 'Me', level: 4, health, max_health: 100, position: { x: 0, y: 1.2, z: 0 } },
    monsters: [
      { id: 'far', monster_type: 'Slime', health: 20, max_health: 20, position: { x: 0, y: 0, z: 9 } },
      { id: 'near', monster_type: 'Slime', health: 20, max_health: 20, position: { x: 3, y: 0, z: 0 } },
    ],
    bag: [{ instance_id: 7, item_def_id: 'Health Potion', quantity: 2 }],
  })

  const healthy = evaluateDocument(document, snapshotFromState(body(80)))
  assert.equal(healthy.matchedRuleId, 'hunt-slimes')
  assert.equal(healthy.actions[0].target.id, 'near', 'nearest is measured on the ground plane')

  const hurt = evaluateDocument(document, snapshotFromState(body(20)))
  assert.equal(hurt.matchedRuleId, 'heal')
  assert.equal(hurt.actions[0].item.name, 'Health Potion')

  // An empty body must not throw or invent a match; it is the state before the
  // agent is in game.
  assert.equal(evaluateDocument(document, snapshotFromState(null)).matchedRuleId, 'patrol')
})
