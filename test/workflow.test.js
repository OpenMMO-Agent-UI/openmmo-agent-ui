'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const workflowPromise = import('../src/workflow.js')

function deferred() {
  let resolve
  const promise = new Promise((res) => {
    resolve = res
  })
  return { promise, resolve }
}

async function fixture(overrides = {}) {
  const { AppWorkflow } = await workflowPromise
  const calls = []
  const api = {
    listProfiles: async () => [
      {
        id: 'official',
        name: 'openmmo.to.nexus',
        lastSession: { characterId: 2 },
      },
    ],
    selectProfile: async (id) => calls.push(['selectProfile', id]),
    testProfile: async (id) => ({ ok: true, profileId: id }),
    authStatus: async () => ({ signedIn: true }),
    authContinue: async () => ({
      ok: true,
      accountName: 'player@example.com',
      characters: [
        { id: 1, name: 'One' },
        { id: 2, name: 'Two' },
      ],
    }),
    authSignIn: async () => ({ ok: true, accountName: 'new@example.com', characters: [] }),
    enterCharacter: async (id) => ({ ok: true, session: { mode: 'ai', characterId: id } }),
    listCharacters: async () => ({ ok: true, characters: [{ id: 2, name: 'Two', level: 9 }] }),
    ...overrides,
  }
  const states = []
  const workflow = new AppWorkflow(api, (state) => states.push(state))
  return { api, calls, states, workflow }
}

test('cold launch always starts at server selection with the last profile selected', async () => {
  const { workflow } = await fixture()

  const state = await workflow.start()

  assert.equal(state.screen, 'server')
  assert.equal(state.selectedProfileId, 'official')
})

test('valid cached OAuth skips login and shows characters with the last character first', async () => {
  const { workflow, calls } = await fixture()
  await workflow.start()

  const state = await workflow.continueWithProfile('official')

  assert.equal(state.screen, 'character')
  assert.equal(state.accountName, 'player@example.com')
  assert.deepEqual(state.characters.map((character) => character.id), [2, 1])
  assert.deepEqual(calls, [['selectProfile', 'official']])
})

test('profile validation failure stays on server selection with an actionable error', async () => {
  const { workflow } = await fixture({
    testProfile: async () => ({ ok: false, error: 'Protocol v10 required' }),
  })
  await workflow.start()

  const state = await workflow.continueWithProfile('official')

  assert.equal(state.screen, 'server')
  assert.deepEqual(state.errors, ['Protocol v10 required'])
})

test('a protocol-mismatch profile test publishes no error toast — the outdated dialog owns it', async () => {
  const { workflow } = await fixture({
    testProfile: async () => ({
      ok: false,
      protocolMismatch: true,
      error: 'Protocol v11 required, you sent v10',
    }),
  })
  await workflow.start()

  const state = await workflow.continueWithProfile('official')

  assert.equal(state.screen, 'server')
  assert.deepEqual(state.errors, [])
})

test('a protocol-mismatch sign-in publishes no error toast', async () => {
  const { workflow } = await fixture({
    authStatus: async () => ({ signedIn: true }),
    authContinue: async () => ({
      ok: false,
      protocolMismatch: true,
      error: 'Protocol v11 required, you sent v10',
    }),
  })
  await workflow.start()

  const state = await workflow.continueWithProfile('official')

  assert.equal(state.screen, 'server')
  assert.deepEqual(state.errors, [])
})

test('late OAuth completion is ignored after returning to server selection', async () => {
  const login = deferred()
  const { workflow } = await fixture({
    authStatus: async () => ({ signedIn: false }),
    authSignIn: () => login.promise,
  })
  await workflow.start()

  const continuing = workflow.continueWithProfile('official')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(workflow.snapshot().screen, 'oauth')
  workflow.cancelOAuth()
  login.resolve({ ok: true, accountName: 'late@example.com', characters: [{ id: 1 }] })
  await continuing

  assert.equal(workflow.snapshot().screen, 'server')
})

test('selecting a character enters the game immediately without a Play step', async () => {
  const { workflow } = await fixture()
  await workflow.start()
  await workflow.continueWithProfile('official')

  const state = await workflow.chooseCharacter(2)

  assert.equal(state.screen, 'game')
  assert.deepEqual(state.session, { mode: 'ai', characterId: 2 })
})

/// chooseCharacter's first publish (`{busy: true}`) merges onto whatever
/// screen was already current rather than declaring one — so it republishes
/// 'character' mid-entry, not just at start(). A consumer that treats every
/// publish carrying screen:'character' as a fresh arrival at the picker (as
/// app.js's renderWorkflow once did) will act on that intermediate tick and
/// undo state the caller just set for the character being entered — see the
/// selectedCharacterId-reset bug this was written to lock in behavior for.
test('chooseCharacter republishes the current screen, unchanged, before it resolves', async () => {
  const { workflow, states } = await fixture()
  await workflow.start()
  await workflow.continueWithProfile('official')
  states.length = 0

  await workflow.chooseCharacter(2)

  assert.equal(states[0].busy, true)
  assert.equal(states[0].screen, 'character')
  assert.equal(states.at(-1).screen, 'game')
})

test('choosing again after returning from the game never republishes the stale game screen', async () => {
  const { workflow, states } = await fixture()
  await workflow.start()
  await workflow.continueWithProfile('official')
  await workflow.chooseCharacter(2)

  const back = await workflow.returnToCharacters()
  states.length = 0
  await workflow.chooseCharacter(2)

  assert.equal(back.screen, 'character')
  assert.equal(back.session, null)
  assert.deepEqual(back.characters, [{ id: 2, name: 'Two', level: 9 }])
  assert.equal(states[0].screen, 'character')
  assert.deepEqual(states.at(-1).session, { mode: 'ai', characterId: 2 })
})

test('a failed roster refresh stays on character selection with the error', async () => {
  const { workflow } = await fixture({ listCharacters: async () => ({ ok: false, error: 'Not signed in' }) })
  await workflow.start()
  await workflow.continueWithProfile('official')

  const state = await workflow.returnToCharacters()

  assert.equal(state.screen, 'character')
  assert.equal(state.busy, false)
  assert.deepEqual(state.errors, ['Not signed in'])
})

// The dead end this closes: a saved credential that the server refuses used to
// drop you back on server selection, where Continue reuses the same credential
// and fails again. The only controls that clear one are Switch account (on the
// character screen, which a refused sign-in never reaches) and Delete (refused
// for the builtin profile), so the sign-in screen's failed card has to be where
// you land — it is the one that offers to forget the login.
test('a refused saved credential lands on the sign-in screen, not back on Continue', async () => {
  const { workflow } = await fixture({
    authStatus: async () => ({ signedIn: true }),
    authContinue: async () => ({ ok: false, error: 'Unexpected reply to sign-in: (undecodable frame)' }),
  })
  await workflow.start()

  const state = await workflow.continueWithProfile('official')

  assert.equal(state.screen, 'oauth')
  assert.deepEqual(state.errors, ['Unexpected reply to sign-in: (undecodable frame)'])
})

test('switching account forgets the saved login before signing in again', async () => {
  const signIns = []
  const { workflow } = await fixture({
    signOut: async () => signIns.push('signOut'),
    authStatus: async () => ({ signedIn: signIns.length === 0 }),
    authSignIn: async () => {
      signIns.push('authSignIn')
      return { ok: true, accountName: 'other@example.com', characters: [] }
    },
  })
  await workflow.start()

  const state = await workflow.switchAccount('official')

  // signOut first, and the fresh device flow rather than authContinue: a
  // re-run that reused the cache would be Try again under another label.
  assert.deepEqual(signIns, ['signOut', 'authSignIn'])
  assert.equal(state.screen, 'character')
  assert.equal(state.accountName, 'other@example.com')
})

// A sign-out that did not happen must not be followed by a sign-in that
// silently reuses the credential and fails identically.
test('a failed sign-out reports itself instead of retrying with the old login', async () => {
  const { workflow, api } = await fixture({
    signOut: async () => {
      throw new Error('EPERM: google.json is locked')
    },
  })
  await workflow.start()
  let continued = false
  api.authStatus = async () => {
    continued = true
    return { signedIn: true }
  }

  const state = await workflow.switchAccount('official')

  assert.deepEqual(state.errors, ['EPERM: google.json is locked'])
  assert.equal(state.busy, false)
  assert.equal(continued, false)
})
