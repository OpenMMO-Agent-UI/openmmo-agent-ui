'use strict'

const fs = require('node:fs')
const path = require('node:path')

const { agentDir } = require('./runtimeEnv')

const NPC_DATA_DIR = 'data/npcs'

function instancePromptRelativePath(characterName) {
  return `${NPC_DATA_DIR}/${characterName}/instance.txt`
}

/// Absolute path to a character's own instance prompt — the personality
/// prompt players actually edit, layered on top of the fixed general persona
/// in user_prompt.txt, mirroring agent-client's own per-registry-NPC
/// instance.txt convention (main.rs), just keyed by character name instead
/// of registry id.
function instancePromptPath(characterName) {
  return path.join(agentDir(), instancePromptRelativePath(characterName))
}

/// Guarantees the file renderConfigToml() is about to reference actually
/// exists — never overwrites existing content.
function ensureInstancePrompt(characterName) {
  const file = instancePromptPath(characterName)
  if (fs.existsSync(file)) return
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '')
}

function memoryRelativePath(characterName) {
  return `${NPC_DATA_DIR}/${characterName}/memory.txt`
}

/// Where agent-client's own `memory_update` writes land, and where the
/// drawer's read-only Memory tab reads from — never written by this app.
function memoryPath(characterName) {
  return path.join(agentDir(), memoryRelativePath(characterName))
}

/// Marks the start of the block this app manages inside a character's
/// instance.txt (sellable/dropable item lists, see labelsBlock below).
/// Everything from this line down is regenerated on every label change and
/// hidden from the Personality textarea — the player only ever edits what
/// comes before it.
const LABELS_MARKER = '<!-- BAG LABELS: DO NOT EDIT BELOW (managed by the app) -->'

/// Strips the app-managed labels block back out of a saved instance.txt,
/// leaving just the player's own prose — the inverse of composeInstanceText.
function splitInstanceText(raw) {
  const idx = String(raw || '').indexOf(LABELS_MARKER)
  const prose = idx === -1 ? String(raw || '') : raw.slice(0, idx)
  return { prose: prose.replace(/\s+$/, '') }
}

/// item_def_id only, deduped, sorted — sell/drop actions have no enchant
/// field (agent-client driver/action.rs), so listing e.g. "iron_sword#2"
/// distinctly from "iron_sword#0" would promise a distinction the model has
/// no way to act on.
function labelsBlock(labels) {
  const idsOf = (keys) => [...new Set((keys || []).map((key) => String(key).split('#')[0]))].sort()
  const sellable = idsOf(labels?.sellable)
  const dropable = idsOf(labels?.dropable)
  if (!sellable.length && !dropable.length) return ''
  const lines = [LABELS_MARKER]
  if (sellable.length) lines.push(`Sellable: ${sellable.join(', ')}`)
  if (dropable.length) lines.push(`Dropable: ${dropable.join(', ')}`)
  return lines.join('\n')
}

/// Player prose plus the current labels block, ready to write to
/// instance.txt. The inverse of splitInstanceText.
function composeInstanceText(prose, labels) {
  const cleanProse = String(prose || '').replace(/\s+$/, '')
  const block = labelsBlock(labels)
  if (!block) return cleanProse ? `${cleanProse}\n` : ''
  return cleanProse ? `${cleanProse}\n\n${block}\n` : `${block}\n`
}

/// user_prompt.txt has no editor in the app any more — the personality
/// prompt (instance.txt, above) is the only thing players write. Without
/// this, a character who never had one created (nothing in the UI does that
/// any more) would get no persona role layer at all: agent-client only
/// includes user_prompt.txt in the prompt if the file exists (orchestrator.rs
/// build_system_prompt), it doesn't fall back to a preset on its own.
function ensureUserPrompt() {
  const dir = path.join(agentDir(), 'data')
  const file = path.join(dir, 'user_prompt.txt')
  if (fs.existsSync(file)) return
  const preset = path.join(dir, 'user_prompts', 'newcomer.txt')
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.copyFileSync(preset, file)
  } catch {
    // No newcomer preset to seed from (unusual layout) — the character just
    // runs on the shared system prompt and its own instance.txt instead.
  }
}

module.exports = {
  instancePromptRelativePath,
  instancePromptPath,
  ensureInstancePrompt,
  memoryRelativePath,
  memoryPath,
  splitInstanceText,
  composeInstanceText,
  ensureUserPrompt,
}
