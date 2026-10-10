'use strict'

import { t } from './renderer/i18n.js'

function clone(value) {
  return value == null ? value : structuredClone(value)
}

export class AppWorkflow {
  constructor(api, onState = () => {}) {
    this.api = api
    this.onState = onState
    this.generation = 0
    this.state = {
      screen: 'server',
      profiles: [],
      selectedProfileId: null,
      accountName: null,
      characters: [],
      errors: [],
      busy: false,
      session: null,
    }
  }

  snapshot() {
    return clone(this.state)
  }

  publish(patch) {
    this.state = { ...this.state, ...patch }
    this.onState(this.snapshot())
    return this.snapshot()
  }

  async start() {
    const profiles = await this.api.listProfiles()
    const selected =
      profiles.find((profile) => profile.selected) ||
      profiles[0] ||
      null
    return this.publish({
      screen: 'server',
      profiles,
      selectedProfileId: selected?.id ?? null,
      accountName: null,
      characters: [],
      errors: [],
      busy: false,
      session: null,
    })
  }

  async continueWithProfile(profileId) {
    const generation = ++this.generation
    this.publish({ busy: true, errors: [], selectedProfileId: profileId })
    const tested = await this.api.testProfile(profileId)
    if (generation !== this.generation) return this.snapshot()
    if (!tested.ok) {
      // A protocol mismatch already opened the outdated dialog; an error toast
      // under it would just repeat the refusal.
      return this.publish({
        screen: 'server',
        busy: false,
        errors: tested.protocolMismatch ? [] : [tested.error || 'Connection profile validation failed'],
      })
    }

    await this.api.selectProfile(profileId)
    if (generation !== this.generation) return this.snapshot()
    const status = await this.api.authStatus()
    if (generation !== this.generation) return this.snapshot()

    let result
    if (status.signedIn) {
      result = await this.api.authContinue()
    } else {
      this.publish({ screen: 'oauth', busy: true })
      result = await this.api.authSignIn()
    }
    if (generation !== this.generation) return this.snapshot()
    if (!result.ok) {
      // A protocol mismatch is not a sign-in problem and has the outdated
      // dialog of its own, so it still drops back to the server list.
      if (result.protocolMismatch) {
        return this.publish({ screen: 'server', busy: false, errors: [] })
      }
      // Anything else lands on the sign-in screen's failed card whether or not
      // a saved credential was used. It used to go back to the server list when
      // one was, which left no way to reach `switchAccount` — that button is on
      // the character screen, and a refused credential never gets there. The
      // only other control that clears one is Delete, refused for the builtin
      // profile, so a stale saved login was an unrecoverable dead end: Continue
      // reuses the credential, fails, and returns you to Continue.
      return this.publish({
        screen: 'oauth',
        busy: false,
        errors: [result.error || 'Sign-in failed'],
      })
    }
    return this.showCharacters(result)
  }

  /// Forget the profile's saved Google login, then sign in again from scratch.
  /// Reached from the character screen ("Switch account") and from the sign-in
  /// screen's failed card, where it is the recovery rather than a convenience:
  /// Try again reuses the credential that just failed.
  async switchAccount(profileId) {
    this.generation++
    this.publish({ busy: true, errors: [] })
    try {
      await this.api.signOut()
    } catch (err) {
      // Nothing was cleared, so a fresh sign-in would silently reuse the old
      // credential and fail the same way. Say so instead.
      return this.publish({ busy: false, errors: [err?.message || t('Could not sign out')] })
    }
    return this.continueWithProfile(profileId ?? this.state.selectedProfileId)
  }

  showCharacters(result) {
    const selectedProfile = this.state.profiles.find(
      (profile) => profile.id === this.state.selectedProfileId,
    )
    const lastCharacterId = selectedProfile?.lastSession?.characterId
    const characters = [...(result.characters || [])]
    if (lastCharacterId != null) {
      characters.sort((a, b) => {
        if (a.id === lastCharacterId) return -1
        if (b.id === lastCharacterId) return 1
        return 0
      })
    }
    return this.publish({
      screen: 'character',
      busy: false,
      errors: [],
      accountName: result.accountName || result.email || null,
      characters,
    })
  }

  cancelOAuth() {
    this.generation++
    void this.api.authCancel?.()
    return this.publish({
      screen: 'server',
      busy: false,
      errors: [],
    })
  }

  async returnToCharacters() {
    this.publish({ screen: 'character', busy: true, errors: [], session: null })
    const result = await this.api.listCharacters()
    if (!result.ok) {
      return this.publish({ busy: false, errors: [result.error || t('Could not load characters')] })
    }
    return this.publish({ busy: false, characters: result.characters })
  }

  async chooseCharacter(characterId) {
    this.publish({ busy: true, errors: [] })
    const result = await this.api.enterCharacter(characterId)
    if (!result.ok) {
      return this.publish({
        screen: 'character',
        busy: false,
        errors: result.errors || [result.error || t('Could not enter the game')],
      })
    }
    return this.publish({
      screen: 'game',
      busy: false,
      session: result.session,
    })
  }
}
