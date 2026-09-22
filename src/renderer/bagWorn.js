'use strict'

import { $, confirmAction } from './dom.js'
import { t } from './i18n.js'

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

/// The three feeds the sheet is drawn from arrive separately — the class with
/// the vitals, the learned skills and the gear from the relay — so each is
/// kept and the sheet redrawn whenever any of them moves.
let skillClass = null
let skillsLearned = []
let skillsWorn = {}
let cooldownUntil = {}
let cooldownTimer = null

/// What the character has on, slot by slot, from the relay's view of the
/// server's inventory frames (src/proxy.js) — the agent's own panel API
/// reports the bag but never the gear.
export function renderWorn(worn) {
  const box = $('wornList')
  box.innerHTML = ''
  const equipped = worn && typeof worn === 'object' ? worn : {}
  skillsWorn = equipped
  let count = 0
  for (const [slot, label] of WORN_SLOTS) {
    const item = equipped[slot]
    if (item) count++
    const row = document.createElement('div')
    row.className = item ? 'worn-row' : 'worn-row worn-bare'
    const name = document.createElement('span')
    name.className = 'worn-slot'
    name.textContent = t(label)
    const value = document.createElement('span')
    value.className = 'worn-item'
    value.textContent = item ? itemLabel(item.itemDefId, item.enchant) : '—'
    row.append(name, value)
    box.appendChild(row)
  }
  // The slot list itself is always drawn, so the hint speaks to the gear:
  // an all-empty sheet is the one case worth saying out loud.
  $('wornEmpty').hidden = count > 0
  drawSkills()
}

/// The game's skills (client abilities.ts, server abilities.rs): who has each
/// — a class by right, or anyone who learned it — and the gear it takes. The
/// gear lists are the game's fixed item list (deps/OpenMMO/data/items.json),
/// the way RESTOCK_ITEMS is. `fire` marks the one the drawer can use on its
/// own; the others need a target the agent picks in the field, or are the
/// fisher worker's job.
const ONE_HANDED_BLADES = new Set([
  'iron_sword',
  'worn_iron_sword',
  'notched_iron_sword',
  'goblin_sword',
  'small_sword',
  'morningstar',
  'steel_longsword',
])
const SHIELDS = new Set(['wooden_shield', 'raven_shield'])
const mainHand = (worn, id) => worn.main_hand?.itemDefId === id
const ABILITIES = [
  {
    id: 'guardian_ward',
    name: 'Guardian Ward',
    class: 'knight',
    gear: 'Sword or mace, and a shield',
    ready: (worn) =>
      ONE_HANDED_BLADES.has(worn.main_hand?.itemDefId) && SHIELDS.has(worn.off_hand?.itemDefId),
    fire: true,
  },
  {
    id: 'dagger_double_slash',
    name: 'Double Slash',
    class: 'rogue',
    gear: 'Dagger',
    ready: (worn) => mainHand(worn, 'dagger'),
  },
  {
    id: 'auscultation',
    name: 'Auscultation',
    gear: 'Stethoscope',
    ready: (worn) => worn.neck?.itemDefId === 'stethoscope',
  },
  {
    id: 'fishing',
    name: 'Fishing',
    learned: true,
    gear: 'Fishing rod',
    ready: (worn) => mainHand(worn, 'fishing_rod'),
  },
]

/// What this character can use: its class's skills, the ones anyone has, and
/// the ones it learned — each with whether the gear it takes is on. Without a
/// known class (no session) only learned skills count, so an empty sheet
/// stays empty.
export function availableSkills(characterClass, learned, worn) {
  const had = Array.isArray(learned) ? learned : []
  const gear = worn && typeof worn === 'object' ? worn : {}
  return ABILITIES.filter((a) =>
    a.learned ? had.includes(a.id) : characterClass && (!a.class || a.class === characterClass),
  ).map((a) => ({
    id: a.id,
    name: a.name,
    source: a.learned ? 'learned' : a.class ? a.class : null,
    gear: a.gear,
    ready: a.ready(gear),
    fire: !!a.fire,
  }))
}

/// Why the server refused a skill (shared/src/ability.rs AbilityRejectReason).
const REJECTIONS = {
  unavailable: "Can't use that right now.",
  equipment: 'Missing the gear for it.',
  cooldown: 'Still on cooldown.',
  out_of_range: 'Out of range.',
  not_enough_mana: 'Not enough mana.',
}

/// Arrives with every vitals poll, so only a change redraws — a sheet redrawn
/// under the pointer every second would never take a click.
export function setCharacterClass(characterClass) {
  const next = typeof characterClass === 'string' ? characterClass : null
  if (next === skillClass) return
  skillClass = next
  drawSkills()
}

/// Learned skills, from the relay's view of the server's owner-private skill
/// frame (src/proxy.js) — the same blind spot in the agent's panel API that
/// makes `renderWorn` necessary.
export function renderSkills(learned) {
  skillsLearned = Array.isArray(learned) ? learned : []
  drawSkills()
}

/// The server's answer to a fired skill: a refusal with its reason, or the
/// cooldowns that follow a use, which hold the Use button down until they
/// run out.
export function onAbilityReply(reply) {
  if (!reply) return
  if (reply.kind === 'rejected') {
    setSkillsStatus(t(REJECTIONS[reply.reason] || REJECTIONS.unavailable))
    return
  }
  const now = Date.now()
  cooldownUntil = {}
  let soonest = Infinity
  for (const [id, ms] of Object.entries(reply.cooldowns || {})) {
    if (ms > 0) {
      cooldownUntil[id] = now + ms
      soonest = Math.min(soonest, ms)
    }
  }
  clearTimeout(cooldownTimer)
  if (soonest < Infinity) cooldownTimer = setTimeout(drawSkills, soonest + 50)
  drawSkills()
}

function setSkillsStatus(text) {
  const el = $('skillsStatus')
  el.textContent = text
  el.hidden = !text
}

async function useSkill(id) {
  setSkillsStatus('')
  const res = await api.useAbility(id)
  if (!res || !res.ok) setSkillsStatus(t("The skill can't reach the server right now."))
}

function drawSkills() {
  const box = $('skillsList')
  box.innerHTML = ''
  const rows = availableSkills(skillClass, skillsLearned, skillsWorn)
  $('skillsEmpty').hidden = rows.length > 0
  const now = Date.now()
  for (const row of rows) {
    const el = document.createElement('div')
    el.className = row.ready ? 'skill-row' : 'skill-row skill-bare'
    const name = document.createElement('span')
    name.className = 'skill-name'
    name.textContent = t(row.name)
    const meta = document.createElement('span')
    meta.className = 'skill-meta'
    const source = row.source === 'learned' ? t('Learned') : row.source ? t(row.source) : t('Anyone')
    meta.textContent = row.ready ? source : `${source} · ${t('Needs {gear}', { gear: t(row.gear) })}`
    el.append(name, meta)
    if (row.fire) {
      const left = (cooldownUntil[row.id] || 0) - now
      const use = document.createElement('button')
      use.className = 'skill-use'
      use.textContent = left > 0 ? t('{s}s', { s: Math.ceil(left / 1000) }) : t('Use')
      use.disabled = !row.ready || left > 0
      use.addEventListener('click', () => useSkill(row.id))
      el.appendChild(use)
    }
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

/// The columns are named once in the panel's head row, so a row carries only
/// the boxes — the S and D letters they used to carry made every row restate a
/// key you could only decode by hovering one of them.
function bagMarkCheckbox(label, itemName, checked, onChange) {
  const cell = document.createElement('label')
  cell.className = 'bag-mark'
  const input = document.createElement('input')
  input.type = 'checkbox'
  input.checked = checked
  input.setAttribute('aria-label', `${t(label)} ${itemName}`)
  input.addEventListener('change', () => onChange(input.checked))
  cell.append(input)
  return cell
}

/// Carried against the carry cap, from the agent's /api/state. Item weights
/// are tenths of a kilo, the same reading the game's own inventory shows, and
/// the cap already carries the hunger band's penalty — a weak character's
/// ceiling drops with it.
export function bagWeightText(weight) {
  if (!weight || !Number.isFinite(weight.carried) || !(weight.capacity > 0)) return null
  const kg = (v) => (v / 10).toFixed(1)
  return t('{carried} / {capacity} kg', { carried: kg(weight.carried), capacity: kg(weight.capacity) })
}

/// Mirrors agent-client's shop_info::format_price and the fork's
/// splitGold/GoldAmount.svelte: 1g = 100s = 10,000c, smallest unit (copper)
/// in, omitting denominations that are zero (but always showing copper if
/// the whole amount is).
export function formatGold(copper) {
  const total = Math.trunc(Math.abs(copper))
  const gold = Math.trunc(total / 10000)
  const silver = Math.trunc((total % 10000) / 100)
  const bronze = total % 100
  const parts = []
  if (gold > 0) parts.push(`${gold}g`)
  if (silver > 0) parts.push(`${silver}s`)
  if (bronze > 0 || parts.length === 0) parts.push(`${bronze}c`)
  return `${copper < 0 ? '-' : ''}${parts.join(' ')}`
}

function renderBagTotals(weight, gold) {
  const weightText = bagWeightText(weight)
  const goldText = gold == null ? '' : formatGold(gold)
  $('bagGold').textContent = goldText
  const weightEl = $('bagWeight')
  weightEl.textContent = weightText || ''
  weightEl.classList.toggle('over', weightText !== null && weight.carried > weight.capacity)
  $('bagTotals').hidden = !goldText && !weightText
}

/// agent-client keeps each pickup as its own bag instance rather than
/// merging stacks, so raw entries repeat the same item many times over —
/// grouped by item + enchant here into one line each, with a total count.
/// Each row carries its own Sellable/Dropable checkboxes, staged into
/// stagedLabels until Apply labels commits them.
export function renderBag(bag, weight, gold) {
  renderBagTotals(weight, gold)
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
  // The column names have nothing to name over an empty bag.
  $('bagHead').hidden = rows.length === 0
  $('bagLabelsSubmit').hidden = rows.length === 0
  for (const row of rows) {
    const el = document.createElement('div')
    el.className = 'bag-row'

    const sell = bagMarkCheckbox('Sell', row.label, stagedLabels.sellable.has(row.key), (checked) => {
      if (checked) stagedLabels.sellable.add(row.key)
      else stagedLabels.sellable.delete(row.key)
    })
    const drop = bagMarkCheckbox('Drop', row.label, stagedLabels.dropable.has(row.key), (checked) => {
      if (checked) stagedLabels.dropable.add(row.key)
      else stagedLabels.dropable.delete(row.key)
    })

    const name = document.createElement('span')
    name.className = 'bag-name'
    name.textContent = row.label
    const qty = document.createElement('span')
    qty.className = 'bag-qty'
    qty.textContent = `×${row.quantity}`
    el.append(sell, drop, name, qty)
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
    $('bagLabelsStatus').textContent = t('No character selected.')
    return
  }
  try {
    const collisions = enchantCollisions()
    if (collisions.length) {
      const proceed = await confirmAction(
        t(
          '{items} — you carry more than one enchant level, and sell/drop can\'t tell them apart. ' +
            'The agent might act on the wrong one. Apply labels anyway?',
          { items: collisions.join(', ') },
        ),
        'Apply anyway',
      )
      if (!proceed) {
        $('bagLabelsStatus').textContent = t('Cancelled.')
        return
      }
    }
    $('bagLabelsStatus').textContent = t('Applying…')
    const res = await api.saveBagLabels(characterId, characterName, {
      sellable: [...stagedLabels.sellable],
      dropable: [...stagedLabels.dropable],
    })
    $('bagLabelsStatus').textContent = res.ok
      ? t('Labels applied.')
      : res.error || t('Failed to apply labels.')
  } catch (err) {
    $('bagLabelsStatus').textContent = err?.message || t('Failed to apply labels.')
  }
}
