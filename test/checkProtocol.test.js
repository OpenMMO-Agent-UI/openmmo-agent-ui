const assert = require('node:assert/strict')
const test = require('node:test')

const { classifyRefusal } = require('../scripts/check-protocol.js')

// The server gates a handshake on the protocol number and then on the dungeon
// layout fingerprint, with a different message for each. check-protocol.js
// used to recognise only the first and report everything else as "accepted",
// so a redeploy that moved the generator without touching the protocol left
// every shipped client locked out while the checker said the server was fine.
test('a protocol refusal names the version the server wants', () => {
  assert.deepEqual(
    classifyRefusal('Protocol v36 required, you sent v1 — reload the page, or update agent-client'),
    { protocol: 36 },
  )
})

test('a layout refusal is a refusal, not silence', () => {
  const verdict = classifyRefusal(
    "This build's dungeon layouts differ from the server's — reload the page, or update agent-client",
  )

  assert.deepEqual(verdict, { layout: true })
  // The regression in one line: this is what main() branches on, and `ok`
  // here is what printed "accepted" over a locked-out fleet.
  assert.ok(!verdict.ok)
  assert.equal(verdict.protocol, undefined)
})

test('an unrecognised refusal is still a refusal', () => {
  const verdict = classifyRefusal('Server is full, try again later')

  assert.deepEqual(verdict, { refused: 'Server is full, try again later' })
  assert.ok(!verdict.ok)
})
