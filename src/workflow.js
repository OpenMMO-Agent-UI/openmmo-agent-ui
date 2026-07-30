'use strict'

;(function expose(root) {
  function clone(value) {
    return value == null ? value : structuredClone(value)
  }

  class AppWorkflow {
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
        return this.publish({
          screen: 'server',
          busy: false,
          errors: [tested.error || 'Connection profile validation failed'],
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
        return this.publish({
          screen: status.signedIn ? 'server' : 'oauth',
          busy: false,
          errors: [result.error || 'Sign-in failed'],
        })
      }
      return this.showCharacters(result)
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

    async chooseCharacter(characterId) {
      this.publish({ busy: true, errors: [] })
      const result = await this.api.enterCharacter(characterId)
      if (!result.ok) {
        return this.publish({
          screen: 'character',
          busy: false,
          errors: result.errors || [result.error || 'Could not enter the game'],
        })
      }
      return this.publish({
        screen: 'game',
        busy: false,
        session: result.session,
      })
    }
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { AppWorkflow }
  if (root) root.AppWorkflow = AppWorkflow
})(typeof window !== 'undefined' ? window : globalThis)
