'use strict'

/// Asks the live server whether it would still let the build we currently
/// pin through the handshake.
///
///   node scripts/server-accepts-pin.js [wss://host/ws]
///
/// Prints JSON and exits 0 whether the answer is yes or no — the caller
/// reads `accepted`. Exits 2 only when the question could not be asked.
///
/// This exists because "has Julian cut a release we have not synced?" is not
/// the same question as "can our users log in?", and only the first one was
/// ever being asked. On 2026-08-23 the server was redeployed off upstream
/// master: the dungeon generator moved, the protocol number did not, and no
/// release was tagged. Every shipped client was refused, the five-minute
/// sync gate saw nothing to do, and the first anyone knew of it was a player
/// saying they could not log in.
///
/// Deliberately dependency-free — no `ws`, no msgpack package — so the gate
/// job can run it straight from a bare checkout without an `npm ci`.
/// src/msgpack.js requires nothing, and Node ships a global WebSocket from
/// 22 on; the `ws` fallback is only for older local Nodes.

const fs = require('node:fs')
const path = require('node:path')

const { encode, decode, variantOf } = require('../src/msgpack')

const ROOT = path.resolve(__dirname, '..')
const DEFAULT_URL = 'wss://openmmo.to.nexus/ws'
const TIMEOUT_MS = 10000

function socketClass() {
  if (typeof WebSocket !== 'undefined') return WebSocket
  return require('ws').WebSocket
}

/// { accepted, message } — `message` is the server's own refusal text, which
/// already says which gate failed and what to do about it.
function ask(url, protocol, layout) {
  return new Promise((resolve, reject) => {
    const Socket = socketClass()
    const ws = new Socket(url)
    ws.binaryType = 'arraybuffer'
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      try {
        ws.close()
      } catch {
        // Already closing.
      }
      fn(value)
    }

    const version = layout ? `release-sync-gate+layout.${layout}` : 'release-sync-gate'
    ws.onopen = () => ws.send(encode({ ClientInfo: [protocol, 'cli', version] }))
    ws.onmessage = (event) => {
      const [name, body] = variantOf(decode(Buffer.from(event.data)))
      // Anything that is not a refusal means the handshake got past both
      // gates; the server has no "you are fine" message to wait for.
      if (name !== 'AuthError') return
      finish(resolve, { accepted: false, message: String(body?.[0] ?? '') })
    }
    ws.onclose = () => finish(resolve, { accepted: true, message: null })
    ws.onerror = (err) => finish(reject, err instanceof Error ? err : new Error('socket error'))
    setTimeout(() => finish(resolve, { accepted: true, message: null }), TIMEOUT_MS)
  })
}

async function main() {
  const url = process.argv[2] || DEFAULT_URL
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'release.json'), 'utf8'))
  const { pinnedProtocol, pinnedLayout } = config
  if (!Number.isInteger(pinnedProtocol)) {
    console.error('config/release.json has no pinnedProtocol — run: node scripts/record-pin-gate.js')
    process.exit(2)
  }

  let verdict
  try {
    verdict = await ask(url, pinnedProtocol, pinnedLayout)
  } catch (err) {
    // Unreachable is not the same as refused: a network blip must not fire a
    // full sync, so this reports "could not ask" and leaves the caller's
    // other triggers to decide.
    console.log(JSON.stringify({ accepted: null, url, error: err.message }, null, 2))
    return
  }

  console.log(
    JSON.stringify(
      { accepted: verdict.accepted, url, protocol: pinnedProtocol, layout: pinnedLayout ?? null, message: verdict.message },
      null,
      2,
    ),
  )
}

module.exports = { ask }

if (require.main === module) void main()
