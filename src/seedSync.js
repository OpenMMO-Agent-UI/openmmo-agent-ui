'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

/// Records, per seed file, the sha256 of the content the *bundle* last wrote
/// there. A runtime file still matching its record was never touched by the
/// user and can be replaced with the new release's copy; anything else is a
/// hand edit and stays. Lives beside the seeded files, so wiping the runtime
/// dir resets the tracking with it.
const STATE_FILE = '.seed-state.json'

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/// Every file under a seed entry, as paths relative to the seed root. An
/// entry is either a single file (system_prompt.txt) or a directory tree
/// (user_prompts/, templates/).
function filesUnder(root, rel) {
  const full = path.join(root, rel)
  let stat
  try {
    stat = fs.statSync(full)
  } catch {
    return []
  }
  if (stat.isFile()) return [rel]
  if (!stat.isDirectory()) return []
  return fs
    .readdirSync(full)
    .flatMap((name) => filesUnder(root, path.join(rel, name)))
}

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(src, dest)
}

function readState(statePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'))
    if (parsed && typeof parsed === 'object' && parsed.hashes) return parsed
  } catch {
    // Absent or unreadable: treated as an install that predates the tracking.
  }
  return null
}

/// Moves whatever seed files already exist out of the way, once, for an
/// install that predates STATE_FILE. Without a record there is no way to tell
/// a hand-edited prompt from one shipped by an older release, and leaving
/// both alone is what left auto-updated users running a current binary
/// against year-old prompts. The copy is kept rather than deleted — the user
/// can pull their edits back out of it.
function backupExisting(runtimeDir, relPaths, stamp) {
  const dir = path.join(runtimeDir, `.backup-${stamp}`)
  let saved = 0
  for (const rel of relPaths) {
    const from = path.join(runtimeDir, rel)
    if (!fs.existsSync(from)) continue
    copyFile(from, path.join(dir, rel))
    saved += 1
  }
  return saved > 0 ? dir : null
}

/// Brings `runtimeDir` up to the seed content shipped in `seedDir`, keeping
/// anything the user changed. Returns what it did, for the caller to log.
function syncSeed({ seedDir, runtimeDir, version, entries, stamp = String(Date.now()) }) {
  const statePath = path.join(runtimeDir, STATE_FILE)
  const state = readState(statePath)
  if (state && state.version === version) return { skipped: true, updated: [], kept: [], backup: null }

  const relPaths = entries.flatMap((entry) => filesUnder(seedDir, entry))
  const recorded = state?.hashes ?? {}
  const backup = state ? null : backupExisting(runtimeDir, relPaths, stamp)
  const hashes = { ...recorded }
  const updated = []
  const kept = []

  for (const rel of relPaths) {
    const src = path.join(seedDir, rel)
    const dest = path.join(runtimeDir, rel)
    // No record and no backup means a first install: nothing to preserve.
    const userOwned = fs.existsSync(dest) && state != null && sha256(dest) !== recorded[rel]
    if (userOwned) {
      kept.push(rel)
      continue
    }
    copyFile(src, dest)
    hashes[rel] = sha256(src)
    updated.push(rel)
  }

  fs.mkdirSync(runtimeDir, { recursive: true })
  fs.writeFileSync(statePath, `${JSON.stringify({ version, hashes }, null, 2)}\n`)
  return { skipped: false, updated, kept, backup }
}

module.exports = { syncSeed, STATE_FILE }
