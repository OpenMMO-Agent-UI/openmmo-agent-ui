'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const BUILTIN_PROFILE_ID = 'openmmo-to-nexus'
const STORE_VERSION = 1

function deriveTerrainOrigin(serverUrl) {
  const url = new URL(serverUrl)
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error('Server URL must use ws:// or wss://')
  }
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
  url.pathname = ''
  url.search = ''
  url.hash = ''
  return url.origin
}

function clone(value) {
  return value == null ? value : structuredClone(value)
}

function normalizeProfile(input, current = {}) {
  const serverUrl = input.serverUrl ?? current.serverUrl
  if (!serverUrl) throw new Error('Server URL is required')
  deriveTerrainOrigin(serverUrl)
  const name = String(input.name ?? current.name ?? '').trim()
  if (!name) throw new Error('Profile name is required')
  const terrainOrigin =
    input.terrainOrigin === undefined
      ? current.terrainOrigin || deriveTerrainOrigin(serverUrl)
      : input.terrainOrigin || deriveTerrainOrigin(serverUrl)
  const terrain = new URL(terrainOrigin)
  if (terrain.protocol !== 'http:' && terrain.protocol !== 'https:') {
    throw new Error('Terrain origin must use http:// or https://')
  }
  return {
    ...current,
    name,
    serverUrl,
    terrainOrigin: terrain.origin,
    googleClientId: String(input.googleClientId ?? current.googleClientId ?? '').trim(),
    lastSession: clone(input.lastSession ?? current.lastSession ?? null),
    validation: clone(input.validation ?? current.validation ?? null),
  }
}

class ConnectionProfileStore {
  constructor({ file, cipher, builtin, legacy = {} }) {
    this.file = file
    this.cipher = cipher
    this.builtin = {
      ...normalizeProfile(builtin),
      id: BUILTIN_PROFILE_ID,
      kind: 'builtin',
    }
    this.builtinSecret = builtin.googleClientSecret || ''
    this.state = this.read() || {
      version: STORE_VERSION,
      selectedProfileId: BUILTIN_PROFILE_ID,
      profiles: [],
      encryptedSecrets: null,
    }
    if (this.state.builtinLastSession) this.builtin.lastSession = clone(this.state.builtinLastSession)
    if (this.state.builtinValidation) this.builtin.validation = clone(this.state.builtinValidation)
    this.secrets = this.decrypt(this.state.encryptedSecrets)
    if (!this.state.migrated) this.migrate(legacy)
    else if (this.state.encryptedSecrets?.startsWith('plain:')) this.persist()
  }

  read() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch {
      return null
    }
  }

  decrypt(value) {
    if (!value) return { profiles: {}, credentials: {} }
    try {
      const decrypted = this.cipher.decrypt(value)
      return {
        profiles: decrypted.profiles || {},
        credentials: decrypted.credentials || {},
      }
    } catch {
      return { profiles: {}, credentials: {} }
    }
  }

  persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const state = {
      ...this.state,
      version: STORE_VERSION,
      encryptedSecrets: this.cipher.encrypt(this.secrets),
    }
    const pending = `${this.file}.pending`
    fs.writeFileSync(pending, JSON.stringify(state, null, 2))
    fs.renameSync(pending, this.file)
  }

  migrate(legacy) {
    const hasLegacy = Boolean(legacy.server || legacy.googleClientId || legacy.refreshToken)
    if (hasLegacy) {
      const isBuiltin =
        legacy.server === this.builtin.serverUrl &&
        (!legacy.googleClientId || legacy.googleClientId === this.builtin.googleClientId)
      let profileId = BUILTIN_PROFILE_ID
      if (!isBuiltin) {
        const imported = this.create(
          {
            name: 'Imported Server',
            serverUrl: legacy.server,
            terrainOrigin: legacy.terrain,
            googleClientId: legacy.googleClientId,
            googleClientSecret: legacy.googleClientSecret,
          },
          false,
        )
        profileId = imported.id
      }
      if (legacy.refreshToken) this.secrets.credentials[profileId] = legacy.refreshToken
      if (legacy.account || legacy.characterId != null) {
        this.setLastSession(profileId, {
          account: legacy.account || null,
          characterId: legacy.characterId ?? null,
        })
      }
      this.state.selectedProfileId = profileId
    }
    this.state.migrated = true
    this.persist()
  }

  rawProfile(id) {
    if (id === BUILTIN_PROFILE_ID) return this.builtin
    return this.state.profiles.find((profile) => profile.id === id) || null
  }

  publicProfile(profile) {
    if (!profile) return null
    const secret = profile.id === BUILTIN_PROFILE_ID
      ? this.builtinSecret
      : this.secrets.profiles[profile.id]?.googleClientSecret
    return {
      ...clone(profile),
      hasGoogleClientSecret: Boolean(secret),
      selected: profile.id === this.state.selectedProfileId,
    }
  }

  list() {
    return [this.publicProfile(this.builtin), ...this.state.profiles.map((profile) => this.publicProfile(profile))]
  }

  get(id) {
    return this.publicProfile(this.rawProfile(id))
  }

  withSecrets(id) {
    const profile = this.rawProfile(id)
    if (!profile) return null
    const googleClientSecret =
      id === BUILTIN_PROFILE_ID
        ? this.builtinSecret
        : this.secrets.profiles[id]?.googleClientSecret || ''
    return { ...clone(profile), googleClientSecret }
  }

  selected() {
    return this.get(this.state.selectedProfileId) || this.get(BUILTIN_PROFILE_ID)
  }

  select(id) {
    if (!this.rawProfile(id)) throw new Error('Connection profile not found')
    this.state.selectedProfileId = id
    this.persist()
    return this.get(id)
  }

  create(input, shouldPersist = true) {
    const id = crypto.randomUUID()
    const profile = {
      ...normalizeProfile(input),
      id,
      kind: 'custom',
    }
    this.state.profiles.push(profile)
    this.secrets.profiles[id] = {
      googleClientSecret: input.googleClientSecret || '',
    }
    if (shouldPersist) this.persist()
    return this.get(id)
  }

  update(id, patch) {
    if (id === BUILTIN_PROFILE_ID) throw new Error('Built-in connection profile is immutable')
    const index = this.state.profiles.findIndex((profile) => profile.id === id)
    if (index === -1) throw new Error('Connection profile not found')
    this.state.profiles[index] = {
      ...normalizeProfile(patch, this.state.profiles[index]),
      id,
      kind: 'custom',
    }
    if (Object.hasOwn(patch, 'googleClientSecret')) {
      this.secrets.profiles[id] = {
        ...this.secrets.profiles[id],
        googleClientSecret: patch.googleClientSecret || '',
      }
    }
    this.persist()
    return this.get(id)
  }

  duplicate(id) {
    const source = this.withSecrets(id)
    if (!source) throw new Error('Connection profile not found')
    return this.create({
      ...source,
      name: `${source.name} copy`,
      lastSession: null,
      validation: null,
    })
  }

  delete(id) {
    if (id === BUILTIN_PROFILE_ID) throw new Error('Built-in connection profile is immutable')
    const before = this.state.profiles.length
    this.state.profiles = this.state.profiles.filter((profile) => profile.id !== id)
    if (this.state.profiles.length === before) throw new Error('Connection profile not found')
    delete this.secrets.profiles[id]
    delete this.secrets.credentials[id]
    if (this.state.selectedProfileId === id) this.state.selectedProfileId = BUILTIN_PROFILE_ID
    this.persist()
  }

  credential(id) {
    if (!this.rawProfile(id)) return null
    return this.secrets.credentials[id] || null
  }

  setCredential(id, refreshToken) {
    if (!this.rawProfile(id)) throw new Error('Connection profile not found')
    if (refreshToken) this.secrets.credentials[id] = refreshToken
    else delete this.secrets.credentials[id]
    this.persist()
  }

  setLastSession(id, lastSession) {
    if (id === BUILTIN_PROFILE_ID) {
      this.builtin.lastSession = clone(lastSession)
      this.state.builtinLastSession = clone(lastSession)
    } else {
      const profile = this.rawProfile(id)
      if (!profile) throw new Error('Connection profile not found')
      profile.lastSession = clone(lastSession)
    }
  }

  rememberSession(id, lastSession) {
    this.setLastSession(id, lastSession)
    this.persist()
    return this.get(id)
  }

  setValidation(id, validation) {
    if (id === BUILTIN_PROFILE_ID) {
      this.builtin.validation = clone(validation)
      this.state.builtinValidation = clone(validation)
    } else {
      const profile = this.rawProfile(id)
      if (!profile) throw new Error('Connection profile not found')
      profile.validation = clone(validation)
    }
    this.persist()
    return this.get(id)
  }
}

module.exports = {
  BUILTIN_PROFILE_ID,
  ConnectionProfileStore,
  deriveTerrainOrigin,
}
