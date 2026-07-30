'use strict'

const fs = require('node:fs')
const path = require('node:path')

const { credentialPath } = require('./config')

/// Client-owned Google sign-in (ADR 0001): the Electron app runs the device
/// flow itself, writing the exact same cache file and shape agent-client's
/// own `google_auth.rs` reads (`CachedToken { client_id, refresh_token }`) —
/// so agent-client, launched afterward, finds a valid cache and never runs
/// its own device flow. Mirrors `run_device_flow`/`id_token` there closely
/// enough that either side reading the other's cache just works.

const DEVICE_CODE_URL = 'https://oauth2.googleapis.com/device/code'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
const SCOPE = 'openid email'

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(credentialPath(), 'utf8'))
  } catch {
    return null
  }
}

function writeCache(clientId, refreshToken) {
  const file = credentialPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ client_id: clientId, refresh_token: refreshToken }, null, 2))
  // Long-lived credential: owner-only, like agent-client's own cache write.
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600)
}

function clearCache() {
  try {
    fs.unlinkSync(credentialPath())
  } catch {
    // Nothing to remove.
  }
}

/// A cached refresh token for exactly this client_id, or null — a cache
/// written under a different client_id (e.g. someone switched connection
/// profiles) means "not signed in as this client," same as agent-client's
/// own `cached.filter(|c| c.client_id == config.client_id)`.
function cachedRefreshToken(clientId) {
  const cached = readCache()
  return cached && cached.client_id === clientId ? cached.refresh_token : null
}

/// Prompt-and-poll half of the device flow. `onCode({url, code, expiresIn})`
/// fires once the code is ready; resolves the refresh token once signed in,
/// and caches it under `clientId` for agent-client to reuse.
async function runDeviceFlow(clientId, clientSecret, onCode) {
  const deviceRes = await fetch(DEVICE_CODE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, scope: SCOPE }),
  })
  if (!deviceRes.ok) {
    throw new Error(
      `Google refused the device-code request (${deviceRes.status}). Is ${clientId} an OAuth ` +
        `client of type "TV and Limited Input devices"?`,
    )
  }
  const device = await deviceRes.json()
  onCode({
    url: device.verification_url,
    code: device.user_code,
    expiresIn: device.expires_in,
  })

  let interval = (device.interval || 5) * 1000
  const deadline = Date.now() + device.expires_in * 1000

  for (;;) {
    await new Promise((r) => setTimeout(r, interval))
    if (Date.now() >= deadline) throw new Error('Google sign-in timed out — try again to get a fresh code')

    const body = new URLSearchParams({
      client_id: clientId,
      device_code: device.device_code,
      grant_type: DEVICE_GRANT,
    })
    if (clientSecret) body.set('client_secret', clientSecret)

    const tokenRes = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    })
    const token = await tokenRes.json()

    if (!token.error) {
      if (!token.refresh_token) throw new Error('Google sign-in returned no refresh_token')
      return token.refresh_token
    }
    if (token.error === 'authorization_pending') continue
    if (token.error === 'slow_down') {
      interval += 5000
      continue
    }
    throw new Error(
      `Google sign-in failed: ${token.error}${token.error_description ? ` (${token.error_description})` : ''}`,
    )
  }
}

/// A freshly minted ID token from a cached refresh token, for the pre-flight
/// session's `Authenticate` message. Mirrors agent-client's own `id_token()`.
async function mintIdToken(refreshToken, clientId, clientSecret) {
  const body = new URLSearchParams({ client_id: clientId, refresh_token: refreshToken, grant_type: 'refresh_token' })
  if (clientSecret) body.set('client_secret', clientSecret)

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  })
  const token = await res.json()
  if (token.error) {
    // A revoked or expired grant cannot be refreshed; drop the cache so the
    // next attempt prompts instead of looping on a dead token.
    if (token.error === 'invalid_grant') clearCache()
    throw new Error(`Google token refresh failed: ${token.error}${token.error_description ? ` (${token.error_description})` : ''}`)
  }
  if (!token.id_token) throw new Error('Google token refresh returned no id_token')
  return token.id_token
}

/// Decodes (never verifies — that's the server's job) the `email` claim out
/// of an id_token, for the Login screen's "Continue as <email>" text only.
function peekEmail(idToken) {
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'))
    return payload.email || null
  } catch {
    return null
  }
}

module.exports = {
  cachedRefreshToken,
  writeCache,
  runDeviceFlow,
  mintIdToken,
  clearCache,
  peekEmail,
}
