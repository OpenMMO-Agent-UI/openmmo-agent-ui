'use strict'

const test = require('node:test')
const assert = require('node:assert')

const { ClientServer, distReady } = require('../src/server')

test('concurrent starts share one listening server', { skip: !distReady() && 'client dist not built' }, async () => {
  const server = new ClientServer()
  try {
    const [a, b] = await Promise.all([server.start(null), server.start(null)])
    assert.match(a, /^http:\/\/127\.0\.0\.1:\d+$/)
    assert.equal(b, a)
  } finally {
    server.stop()
  }
})

/// The embedded client's Google sign-in is inlined by Vite at build time, so
/// the bundle ships the placeholder and this substitutes the real id when the
/// file is served — our stand-in for upstream's docker/client-entrypoint.sh.
/// Without it LoginScreen's `if (!clientId)` fires and the only thing the
/// embedded client will say is "Sign-in is currently unavailable", with no way
/// forward. That is exactly what a player reported, and nothing caught it
/// because an un-substituted bundle looks perfectly well-formed.
const { injectClientId, CLIENT_ID_PLACEHOLDER } = require('../src/server')

const bundle = (id) => Buffer.from(`const clientId="${id}";init(clientId)`)

test('the client id placeholder is substituted in js and html', () => {
  const real = '123-abc.apps.googleusercontent.com'
  for (const ext of ['.js', '.html']) {
    const out = injectClientId(bundle(CLIENT_ID_PLACEHOLDER), ext, real)
    assert.equal(out.toString(), bundle(real).toString())
    assert.ok(!out.toString().includes(CLIENT_ID_PLACEHOLDER), `${ext} still has the placeholder`)
  }
})

test('other file types and unsubstitutable bundles are passed through byte for byte', () => {
  const withPlaceholder = bundle(CLIENT_ID_PLACEHOLDER)
  // A .json asset is not rewritten even if it somehow contains the token.
  assert.equal(injectClientId(withPlaceholder, '.json', 'x'), withPlaceholder)
  // A bundle that never had the placeholder is returned as-is, not re-encoded.
  const plain = bundle('already-real')
  assert.equal(injectClientId(plain, '.js', 'x'), plain)
})

/// No profile selected yet is not the same as a profile with no id: the first
/// must leave the placeholder intact so a later serve can still fill it.
test('an unknown client id leaves the bundle alone, an empty one substitutes', () => {
  const src = bundle(CLIENT_ID_PLACEHOLDER)
  assert.equal(injectClientId(src, '.js', undefined), src)
  assert.equal(injectClientId(src, '.js', '').toString(), bundle('').toString())
})
