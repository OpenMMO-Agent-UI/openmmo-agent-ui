'use strict'

const fs = require('node:fs')
const path = require('node:path')

// Player-saved data scoped by connection profile and stable character ID —
// labels, coordinates, and dispatch presets all share this shape. The
// personality/instance-prompt file is deliberately not a kind here: it's
// text, not JSON, and its writes carry extra composition logic (see
// config.composeInstanceText) that belongs to the caller, not the store.
const KINDS = {
  labels: {
    default: () => ({ sellable: [], dropable: [] }),
    normalize: (parsed) => ({
      sellable: Array.isArray(parsed?.sellable) ? parsed.sellable : [],
      dropable: Array.isArray(parsed?.dropable) ? parsed.dropable : [],
    }),
  },
  coordinates: {
    default: () => [],
    normalize: (parsed) => (Array.isArray(parsed) ? parsed : []),
  },
  presets: {
    default: () => [],
    normalize: (parsed) => (Array.isArray(parsed) ? parsed : []),
  },
}

function safe(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '_')
}

class CharacterStore {
  constructor({ baseDir }) {
    this.baseDir = baseDir
  }

  open(kind, profileId, characterId) {
    const shape = KINDS[kind]
    if (!shape) throw new Error(`Unknown character store kind: ${kind}`)
    const file = path.join(this.baseDir, kind, safe(profileId), `${safe(characterId)}.json`)
    return {
      read: () => {
        try {
          return shape.normalize(JSON.parse(fs.readFileSync(file, 'utf8')))
        } catch {
          return shape.default()
        }
      },
      write: (value) => {
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, JSON.stringify(value))
      },
    }
  }
}

module.exports = { CharacterStore }
