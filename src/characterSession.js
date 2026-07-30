'use strict'

const { WebSocket } = require('ws')

const { encode, decode, variantOf } = require('./msgpack')
const { protocolVersion } = require('./config')

/// The pre-flight session (ADR 0001): a direct, throwaway WebSocket
/// connection to the game server — bypassing agent-client entirely — that
/// signs in and owns all character list/create/delete. agent-client is
/// launched only afterward, with `character_name` set to an exact,
/// already-existing match, so its own auto-create/auto-delete logic never
/// activates. Only this narrow, deliberately stable corner of the wire
/// protocol is hand-encoded here — never movement, combat, or inventory.
///
/// The protocol guard (ADR 0002) fails closed: a version mismatch here means
/// the real game session would fail too, just later and less clearly, so
/// this throws instead of falling back to the plain character-name field.

const REPLY_TIMEOUT_MS = 10000
const PROFILE_TEST_TIMEOUT_MS = 5000
const PROTOCOL_MISMATCH = /^Protocol v(\d+) required, you sent v(\d+)/

class ProtocolMismatchError extends Error {}

function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data
  if (Array.isArray(data)) return Buffer.concat(data)
  return Buffer.from(data)
}

/// Resolves the next decoded [name, body] frame, or rejects on close/error/
/// timeout. One frame at a time is all the pre-flight session ever needs —
/// every step here is a single send-then-await, never concurrent.
function nextMessage(ws, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      resolve(null)
    }, timeoutMs)
    function cleanup() {
      clearTimeout(timer)
      ws.off('message', onMessage)
      ws.off('close', onClose)
      ws.off('error', onError)
    }
    function onMessage(data) {
      cleanup()
      resolve(variantOf(decode(toBuffer(data))))
    }
    function onClose(code, reason) {
      cleanup()
      reject(new Error(`The server closed the connection (${code}) ${reason || ''}`.trim()))
    }
    function onError(err) {
      cleanup()
      reject(err)
    }
    ws.on('message', onMessage)
    ws.once('close', onClose)
    ws.once('error', onError)
  })
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const onError = (err) => {
      ws.off('open', onOpen)
      reject(err)
    }
    const onOpen = () => {
      ws.off('error', onError)
      resolve(ws)
    }
    ws.once('open', onOpen)
    ws.once('error', onError)
  })
}

/// A connection profile gate before OAuth. A matching ClientInfo handshake is
/// intentionally silent, so follow it with an empty Authenticate: a compatible
/// server must answer AuthError, proving it decoded the pinned protocol.
async function testConnection(serverUrl, terrainOrigin, fetchFn = fetch) {
  let ws
  try {
    ws = await connect(serverUrl)
    ws.send(encode({ ClientInfo: [protocolVersion(), 'desktop', 'profile-test'] }))
    ws.send(encode({ Authenticate: [''] }))
    const reply = await nextMessage(ws, PROFILE_TEST_TIMEOUT_MS)
    if (!reply) throw new Error('Server did not acknowledge the pinned protocol')
    if (reply[0] === 'AuthError') {
      const message = authErrorMessage(reply[0], reply[1]) || ''
      if (PROTOCOL_MISMATCH.test(message)) throw new ProtocolMismatchError(message)
    } else {
      throw new Error(`Unexpected profile-test reply: ${reply[0]}`)
    }
  } finally {
    if (ws) ws.close()
  }

  if (terrainOrigin) {
    const origin = new URL(terrainOrigin)
    const res = await fetchFn(origin, {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) throw new Error(`Terrain origin returned HTTP ${res.status}`)
  }
  return { ok: true }
}

function authErrorMessage(name, body) {
  return name === 'AuthError' && Array.isArray(body) ? body[0] : null
}

/// Opens the pre-flight session: connects, sends the protocol-guard
/// handshake (failing closed on a version mismatch per ADR 0002), signs in
/// with the given Google id_token, and returns { accountName, characters,
/// createCharacter, deleteCharacter, close }.
async function openSession(serverUrl, idToken) {
  const ws = await connect(serverUrl)
  const mine = protocolVersion()

  // Sent back to back, no round trip in between: the server replies to
  // ClientInfo only on refusal (handle_handshake in connection.rs returns
  // nothing on a version match), so the first reply we actually get is
  // either that refusal or the answer to Authenticate — distinguished by
  // content, not by which slot it arrived in.
  ws.send(encode({ ClientInfo: [mine, 'cli', 'pre-flight'] }))
  ws.send(encode({ Authenticate: [idToken] }))

  const [name, body] = (await nextMessage(ws, REPLY_TIMEOUT_MS)) || []
  if (name === 'AuthError') {
    const message = authErrorMessage(name, body) || 'Sign-in was refused'
    ws.close()
    if (PROTOCOL_MISMATCH.test(message)) throw new ProtocolMismatchError(message)
    throw new Error(message)
  }
  if (name !== 'AuthSuccess' || !Array.isArray(body)) {
    ws.close()
    throw new Error(`Unexpected reply to sign-in: ${name || '(undecodable frame)'}`)
  }
  const [accountName, characters] = body

  return {
    accountName,
    characters: characters.map(characterFromWire),
    createCharacter: (characterName, characterClass, gender) => createCharacter(ws, characterName, characterClass, gender),
    deleteCharacter: (characterId) => deleteCharacter(ws, characterId),
    close: () => ws.close(),
  }
}

/// `Character` is a positional array on the wire (shared/src/character.rs):
/// [id, name, created_at, level, xp, max_hp, attributes, class, gender].
function characterFromWire(c) {
  const [id, name, createdAt, level, xp, maxHp, attributes, characterClass, gender] = c
  return { id, name, createdAt, level, xp, maxHp, attributes, class: characterClass, gender }
}

/// Create requires a prior roll — the server rejects CreateCharacter without
/// one (connection.rs: "Roll attributes first"). Without an LLM to weigh in,
/// the first roll stands, mirroring agent-client's own no-agent path
/// (orchestrator.rs's roll_stats_with_agent).
async function createCharacter(ws, characterName, characterClass, gender) {
  ws.send(encode({ RollCharacterStats: [characterClass, gender] }))
  const rolled = await nextMessage(ws, REPLY_TIMEOUT_MS)
  if (!rolled || rolled[0] !== 'CharacterStatsRolled') {
    throw new Error('The server did not confirm a stat roll')
  }

  ws.send(encode({ CreateCharacter: [characterName, characterClass, gender] }))
  const created = await nextMessage(ws, REPLY_TIMEOUT_MS)
  if (!created) throw new Error('The server did not respond to character creation')
  const [name, body] = created
  if (name === 'CharacterError') throw new Error((Array.isArray(body) && body[0]) || 'Character creation failed')
  if (name !== 'CharacterCreated') throw new Error(`Unexpected reply to character creation: ${name}`)
  return characterFromWire(body[0])
}

async function deleteCharacter(ws, characterId) {
  ws.send(encode({ DeleteCharacter: [characterId] }))
  const reply = await nextMessage(ws, REPLY_TIMEOUT_MS)
  if (!reply) throw new Error('The server did not respond to character deletion')
  const [name, body] = reply
  if (name === 'CharacterError') throw new Error((Array.isArray(body) && body[0]) || 'Character deletion failed')
  if (name !== 'CharacterDeleted') throw new Error(`Unexpected reply to character deletion: ${name}`)
}

module.exports = { openSession, testConnection, ProtocolMismatchError }
