const assert = require('node:assert/strict')
const fs = require('node:fs')
const test = require('node:test')

const { pinGate, CONFIG } = require('../scripts/record-pin-gate.js')

// config/release.json carries the pinned build's protocol number and dungeon
// layout fingerprint so release-sync.yml's five-minute gate can ask the live
// server "would you still accept what we ship?" without cloning the
// submodule. That is duplicated state, and duplicated state drifts — so this
// is the check that makes drift a red build instead of a silent lockout.
test('release.json records the gate the pinned submodule actually presents', (t) => {
  const gate = pinGate()
  if (!gate) {
    t.skip('deps/OpenMMO is not checked out')
    return
  }

  const config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'))

  assert.equal(
    config.pinnedProtocol,
    gate.pinnedProtocol,
    'config/release.json is stale — run: node scripts/record-pin-gate.js',
  )
  assert.equal(
    config.pinnedLayout,
    gate.pinnedLayout,
    'config/release.json is stale — run: node scripts/record-pin-gate.js',
  )
})

test('the recorded protocol is one a release is allowed to ship', () => {
  const config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'))

  assert.ok(Number.isInteger(config.pinnedProtocol))
  assert.match(config.pinnedLayout, /^[0-9a-f]{16}$/)
  // Same rule release-plan.js enforces for the pin itself; stated here too so
  // a recorded-but-unverified protocol cannot slip in via this file.
  assert.ok(
    config.verifiedProtocols.includes(config.pinnedProtocol),
    `pinned protocol v${config.pinnedProtocol} is not in verifiedProtocols`,
  )
})
