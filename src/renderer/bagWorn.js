'use strict'

import { $, confirmAction } from './dom.js'

const api = window.agentApp

/// Every slot the game has (shared/src/inventory.rs EquipSlot), head down and
/// then hands, so the list reads like a character sheet and an empty slot is
/// as visible as a filled one — "no chest armour" is worth seeing.
const WORN_SLOTS = [
  ['head', 'Head'],
  ['neck', 'Neck'],
  ['ear', 'Ear'],
  ['chest', 'Chest'],
  ['shirt', 'Shirt'],
  ['back', 'Back'],
  ['belt', 'Belt'],
  ['pants', 'Pants'],
  ['boots', 'Boots'],
  ['hands', 'Hands'],
  ['main_hand', 'Main hand'],
  ['off_hand', 'Off hand'],
  ['ring', 'Ring'],
  ['ring_left', 'Ring (left)'],
]

/// item_def_id is a snake_case identifier ("healing_potion") — turn it into
/// words, with the enchant level prefixed the way the game names enchanted
/// gear ("+2 Iron Sword").
export function itemLabel(id, enchant) {
  const words = id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  return enchant ? `+${enchant} ${words}` : words
}

/// What the character has on, slot by slot, from the relay's view of the
/// server's inventory frames (src/proxy.js) — the agent's own panel API
/// reports the bag but never the gear.
export function renderWorn(worn) {
  const box = $('wornList')
  box.innerHTML = ''
  const equipped = worn && typeof worn === 'object' ? worn : {}
  let count = 0
  for (const [slot, label] of WORN_SLOTS) {
    const item = equipped[slot]
    if (item) count++
    const row = document.createElement('div')
    row.className = item ? 'worn-row' : 'worn-row worn-bare'
    const name = document.createElement('span')
    name.className = 'worn-slot'
    name.textContent = label
    const value = document.createElement('span')
    value.className = 'worn-item'
    value.textContent = item ? itemLabel(item.itemDefId, item.enchant) : '—'
    row.append(name, value)
    box.appendChild(row)
  }
  // The slot list itself is always drawn, so the hint speaks to the gear:
  // an all-empty sheet is the one case worth saying out loud.
  $('wornEmpty').hidden = count > 0
}

/// Player-facing skill names (shared/src/skills.rs SkillId::display_name).
/// Anything the server trains that isn't listed falls back to its raw id, so a
/// new upstream skill shows up as a row rather than vanishing.
const SKILL_NAMES = { fishing: 'Fishing' }

/// The game's XP curve, ported from shared/src/skills.rs: cumulative XP for a
/// level is `Σ 100·l²` = `100·n(n+1)(2n+1)/6`, capped at level 30. Duplicated
/// rather than shared because that crate reaches the web client through wasm,
/// which this renderer has no part of.
const SKILL_LEVEL_CAP = 30
function skillXpForLevel(level) {
  const n = Math.min(level, SKILL_LEVEL_CAP)
  return (100 * n * (n + 1) * (2 * n + 1)) / 6
}

/// How far into the current level the character is, 0–100. A capped skill
/// reads full: there is no next level to be partway to.
export function skillProgressPct(progress) {
  if (progress.level >= SKILL_LEVEL_CAP) return 100
  const start = skillXpForLevel(progress.level)
  const next = skillXpForLevel(progress.level + 1)
  return Math.max(0, Math.min(100, ((progress.xp - start) / (next - start)) * 100))
}

/// Trained skills, from the relay's view of the server's owner-private skill
/// frames (src/proxy.js) — the same blind spot in the agent's panel API that
/// makes `renderWorn` necessary. Unlike gear there is no fixed slot list: a
/// skill has no row until it is first trained.
export function renderSkills(skills) {
  const box = $('skillsList')
  box.innerHTML = ''
  const rows = Object.entries(skills && typeof skills === 'object' ? skills : {})
    .map(([id, progress]) => ({ id, name: SKILL_NAMES[id] || id, progress }))
    .sort((a, b) => a.name.localeCompare(b.name))
  $('skillsEmpty').hidden = rows.length > 0
  for (const row of rows) {
    const el = document.createElement('div')
    el.className = 'skill-row'
    const name = document.createElement('span')
    name.className = 'skill-name'
    name.textContent = row.name
    const level = document.createElement('span')
    level.className = 'skill-level'
    level.textContent = `Lv ${row.progress.level}`
    const pct = skillProgressPct(row.progress)
    const track = document.createElement('div')
    track.className = 'skill-track'
    track.setAttribute('role', 'progressbar')
    track.setAttribute('aria-valuemin', '0')
    track.setAttribute('aria-valuemax', '100')
    track.setAttribute('aria-valuenow', String(Math.round(pct)))
    track.title = `${row.progress.xp} XP`
    const fill = document.createElement('span')
    fill.className = 'skill-fill'
    fill.style.width = `${pct}%`
    track.appendChild(fill)
    el.append(name, level, track)
    box.appendChild(el)
  }
}

/// Sellable/dropable marks for the currently loaded character — the source
/// of truth is main.js's labels.json; instance.txt's own copy is just a
/// rendering of this for agent-client to read (see config.composeInstanceText).
/// Staged in-memory as Sets of "item_def_id#enchant" bag-row keys and only
/// written to disk when Apply labels is clicked.
let stagedLabels = { sellable: new Set(), dropable: new Set() }
/// The bag rows from the most recent render, kept around so submit can check
/// for enchant collisions without re-deriving them.
let currentBagRows = []

export async function loadBagLabels(characterId) {
  stagedLabels = { sellable: new Set(), dropable: new Set() }
  $('bagLabelsStatus').textContent = ''
  if (!characterId) return
  const saved = await api.getBagLabels(characterId)
  stagedLabels = {
    sellable: new Set(saved.sellable || []),
    dropable: new Set(saved.dropable || []),
  }
}

function bagMarkCheckbox(letter, title, checked, onChange) {
  const label = document.createElement('label')
  label.className = 'bag-mark'
  label.title = title
  const input = document.createElement('input')
  input.type = 'checkbox'
  input.checked = checked
  input.addEventListener('change', () => onChange(input.checked))
  const span = document.createElement('span')
  span.textContent = letter
  label.append(input, span)
  return label
}

/// agent-client keeps each pickup as its own bag instance rather than
/// merging stacks, so raw entries repeat the same item many times over —
/// grouped by item + enchant here into one line each, with a total count.
/// Each row carries its own Sellable/Dropable checkboxes, staged into
/// stagedLabels until Apply labels commits them.
export function renderBag(bag) {
  const box = $('bagList')
  box.innerHTML = ''
  const grouped = new Map()
  for (const item of bag || []) {
    const key = `${item.item_def_id}#${item.enchant || 0}`
    grouped.set(key, (grouped.get(key) || 0) + (item.quantity || 1))
  }
  const rows = [...grouped.entries()]
    .map(([key, quantity]) => {
      const [id, enchant] = key.split('#')
      return { key, id, enchant: Number(enchant), label: itemLabel(id, Number(enchant)), quantity }
    })
    .sort((a, b) => a.label.localeCompare(b.label))
  currentBagRows = rows

  $('bagEmpty').hidden = rows.length > 0
  $('bagLabelsSubmit').hidden = rows.length === 0
  for (const row of rows) {
    const el = document.createElement('div')
    el.className = 'bag-row'

    const marks = document.createElement('span')
    marks.className = 'bag-marks'
    marks.append(
      bagMarkCheckbox('S', 'Sellable', stagedLabels.sellable.has(row.key), (checked) => {
        if (checked) stagedLabels.sellable.add(row.key)
        else stagedLabels.sellable.delete(row.key)
      }),
      bagMarkCheckbox('D', 'Dropable', stagedLabels.dropable.has(row.key), (checked) => {
        if (checked) stagedLabels.dropable.add(row.key)
        else stagedLabels.dropable.delete(row.key)
      }),
    )

    const name = document.createElement('span')
    name.className = 'bag-name'
    name.textContent = row.label
    const qty = document.createElement('span')
    qty.className = 'bag-qty'
    qty.textContent = `×${row.quantity}`
    el.append(marks, name, qty)
    box.appendChild(el)
  }
}

/// sell/drop actions take only an item_def_id, with no way to say which
/// enchant level they mean (agent-client driver/action.rs) — so marking one
/// enchant variant while carrying another is ambiguous: the model could act
/// on either. Surfaced as one consolidated warning per submit, listing every
/// item_def_id in the staged batch that has more than one enchant variant in
/// the current bag.
function enchantCollisions() {
  const enchantsById = new Map()
  for (const row of currentBagRows) {
    if (!enchantsById.has(row.id)) enchantsById.set(row.id, new Set())
    enchantsById.get(row.id).add(row.enchant)
  }
  const ids = new Set()
  for (const key of [...stagedLabels.sellable, ...stagedLabels.dropable]) {
    const id = key.split('#')[0]
    if ((enchantsById.get(id)?.size || 0) > 1) ids.add(id)
  }
  return [...ids].map((id) => itemLabel(id)).sort()
}

export async function submitBagLabels(characterId, characterName) {
  if (!characterId) {
    $('bagLabelsStatus').textContent = 'No character selected.'
    return
  }
  try {
    const collisions = enchantCollisions()
    if (collisions.length) {
      const proceed = await confirmAction(
        `${collisions.join(', ')} — you carry more than one enchant level, and sell/drop can't tell them apart. ` +
          'The agent might act on the wrong one. Apply labels anyway?',
        'Apply anyway',
      )
      if (!proceed) {
        $('bagLabelsStatus').textContent = 'Cancelled.'
        return
      }
    }
    $('bagLabelsStatus').textContent = 'Applying…'
    const res = await api.saveBagLabels(characterId, characterName, {
      sellable: [...stagedLabels.sellable],
      dropable: [...stagedLabels.dropable],
    })
    $('bagLabelsStatus').textContent = res.ok ? 'Labels applied.' : res.error || 'Failed to apply labels.'
  } catch (err) {
    $('bagLabelsStatus').textContent = err?.message || 'Failed to apply labels.'
  }
}
