'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

/// `src/proxy.js` dispatches on wire message names it hardcodes as strings.
/// Nothing tied those strings to upstream's enums, so a renamed or deleted
/// variant does not break the proxy — it makes a branch stop firing, silently,
/// and the only symptom is a spectator view that quietly lacks something.
///
/// Measured when this test was written, against protocol 118: six of the names
/// did not exist. `SpawnMonsterRequest` was removed upstream in **v37** and
/// `DungeonDoorsState` in **v105** (both named in `shared/src/lib.rs`'s own
/// protocol changelog), and `PlayerMove`, `MonsterMove`, `MonsterAssigned` and
/// `PositionCorrected` exist nowhere in the protocol at all. The proxy had been
/// carrying them for roughly eighty protocol versions.
///
/// `PlayerMove` is the expensive one. Translating the agent's outbound move
/// into the `PlayerMoved` its neighbours receive is the stated reason the proxy
/// exists (see its header comment) — the server does not echo a mover its own
/// movement, so without that translation a spectator never sees the agent walk.
/// The real outbound variants are `PlayerMoveGoal` / `PlayerMoveStop` /
/// `PlayerMoveDirection`, and they carry a *goal*, not a position, so the dead
/// branch cannot be repaired by renaming it.
///
/// This test is the gate that was missing: every name the proxy dispatches on
/// must exist in `ClientMessage` or `ServerMessage`. It fails on drift at the
/// next release instead of after eighty of them.

const ROOT = path.join(__dirname, '..')
const MESSAGES = path.join(ROOT, 'deps', 'OpenMMO', 'shared', 'src', 'messages.rs')

/// Names that are deliberately not wire variants: Node/HTTP/errno strings and
/// the proxy's own vocabulary. Anything added here needs a reason, because the
/// whole point is that unexplained names are bugs.
const NOT_WIRE_NAMES = new Set([
  'Delete', // HTTP method in the mirror's CORS allowlist
  'Enter', // keyboard key
  'Leave', // ws close reason
  'EADDRINUSE', // errno from the mirror listener
])

function variantsOf(source, enumName) {
  const start = source.indexOf(`pub enum ${enumName}`)
  assert.notEqual(start, -1, `${enumName} not found in messages.rs`)
  const body = source.slice(start, source.indexOf('\n}\n', start))
  return [...body.matchAll(/^ {4}([A-Z][A-Za-z0-9]*)\s*[({,]/gm)].map((m) => m[1])
}

test('every wire message name the proxy dispatches on exists upstream', (t) => {
  if (!fs.existsSync(MESSAGES)) {
    t.skip('deps/OpenMMO not checked out')
    return
  }
  const source = fs.readFileSync(MESSAGES, 'utf8')
  const known = new Set([
    ...variantsOf(source, 'ServerMessage'),
    ...variantsOf(source, 'ClientMessage'),
  ])
  // A parse that found almost nothing would pass this test by accident.
  assert.ok(known.size > 150, `parsed only ${known.size} variants — the parser is wrong, not the proxy`)

  const proxy = fs.readFileSync(path.join(ROOT, 'src', 'proxy.js'), 'utf8')
  const used = new Set(
    [...proxy.matchAll(/['"]([A-Z][A-Za-z0-9]{3,})['"]/g)]
      .map((m) => m[1])
      .filter((n) => !NOT_WIRE_NAMES.has(n))
  )
  assert.ok(used.size > 20, `parsed only ${used.size} names from proxy.js — the parser is wrong`)

  const dead = [...used].filter((n) => !known.has(n)).sort()
  assert.deepEqual(
    dead,
    [],
    `src/proxy.js dispatches on ${dead.length} message name(s) that do not exist in the ` +
      `protocol, so those branches never fire: ${dead.join(', ')}`
  )
})
