'use strict'

import { $ } from './dom.js'
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

/// The game's own item table, by id, once the main process has handed it
/// over. Until then, and for anything the table does not name, `itemLabel`
/// falls back to reading the id as words.
let catalogueById = new Map()

/// Every item the game ships, name-sorted in the panel's language. Fetched
/// once: it is fixed content, and the drawer opens often.
let catalogueRows = null

export async function loadItemCatalogue({ reload = false } = {}) {
  if (catalogueRows && !reload) return catalogueRows
  try {
    catalogueRows = (await api.getItemCatalogue()) || []
  } catch {
    // No table, no catalogue mode. The drawer lists the bag, which is all it
    // could do before this existed, and `itemLabel` reads ids as words.
    catalogueRows = []
  }
  catalogueById = new Map(catalogueRows.map((row) => [row.id, row]))
  return catalogueRows
}

/// item_def_id is a snake_case identifier ("healing_potion") — the game's own
/// name for it when we have the table (localized, where the game has a
/// dictionary), otherwise the id read as words. The enchant level is
/// prefixed the way the game names enchanted gear ("+2 Iron Sword").
export function itemLabel(id, enchant) {
  const known = catalogueById.get(id)?.name
  const words = known || id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
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
/// Staged in-memory as Sets of item_def_ids and only written to disk when
/// Apply labels is clicked.
///
/// Plain ids, not the `item_def_id#enchant` keys this used to stage. The
/// enchant half was never written to disk and could never be acted on — the
/// agent's sell and drop actions have no enchant field — so all it did was
/// split one item's mark across as many checkboxes as the bag held enchant
/// levels, and raise a confirmation on submit to apologise for it. A mark on
/// `iron_sword` is a mark on iron swords.
let stagedLabels = { sellable: new Set(), dropable: new Set() }

/// Marks saved by an older build arrive as `id#enchant`. Read back as ids,
/// deduped — two rows that only differed by enchant were always one mark.
function idsOf(keys) {
  return new Set((keys || []).map((key) => String(key).split('#')[0]).filter(Boolean))
}

export async function loadBagLabels(characterId) {
  stagedLabels = { sellable: new Set(), dropable: new Set() }
  $('bagLabelsStatus').textContent = ''
  if (!characterId) return
  const saved = await api.getBagLabels(characterId)
  stagedLabels = { sellable: idsOf(saved.sellable), dropable: idsOf(saved.dropable) }
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
/// grouped into one line per item here, with a total count.
///
/// Per item, not per item+enchant, which is what this used to do. A sell or
/// drop mark is per `item_def_id` and always was: the agent's own actions
/// carry no enchant field, so splitting one mark across a +0 row and a +2 row
/// offered a distinction nothing downstream could honour, and ticking one box
/// silently armed the other. The levels in the bag are named in the label
/// instead, so nothing is hidden — "Iron Sword (+0, +2)".
export function bagRows(bag) {
  const grouped = new Map()
  for (const item of bag || []) {
    const id = item.item_def_id
    const row = grouped.get(id) || { quantity: 0, locked: false, enchants: new Set() }
    row.quantity += item.quantity || 1
    row.locked ||= Boolean(item.locked)
    row.enchants.add(Number(item.enchant) || 0)
    grouped.set(id, row)
  }
  return [...grouped.entries()]
    .map(([id, { quantity, locked, enchants }]) => {
      const levels = [...enchants].sort((a, b) => a - b)
      // One unenchanted stack is the ordinary case and says nothing worth
      // saying; anything else is worth spelling out.
      const plain = levels.length === 1 && levels[0] === 0
      const label = plain
        ? itemLabel(id)
        : `${itemLabel(id)} (${levels.map((n) => `+${n}`).join(', ')})`
      return { id, enchants: levels, label, quantity, locked }
    })
    .sort((a, b) => a.label.localeCompare(b.label))
}

const LOCK_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round">' +
  '<rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>'

/// The last bag we were handed, so the catalogue toggle can redraw without
/// waiting for the next poll — a checkbox that does nothing until the agent
/// ticks reads as broken.
let lastBag = []

/// Whether the drawer is listing the whole catalogue or just what is carried.
/// Carried is the default: it is the shorter list and the common errand.
let showEverything = false

/// One row per item in the catalogue, in the shape `drawRows` wants. No
/// quantity and no lock: neither is a property of an item we may not hold.
/// What the bag *does* hold is still counted, so switching to the full list
/// does not lose sight of it.
function catalogueRowsFor(bag) {
  const carried = new Map(bagRows(bag).map((row) => [row.id, row]))
  return (catalogueRows || []).map((item) => ({
    id: item.id,
    label: item.name,
    quantity: carried.get(item.id)?.quantity || 0,
    locked: carried.get(item.id)?.locked || false,
  }))
}

export function renderBag(bag, weight, gold) {
  lastBag = bag || []
  renderBagTotals(weight, gold)
  drawRows()
}

function drawRows() {
  const box = $('bagList')
  box.innerHTML = ''
  // Catalogue mode collapses the bag's enchant variants into one row per
  // item, which is also the granularity a mark has.
  const rows = showEverything
    ? catalogueRowsFor(lastBag)
    : bagRows(lastBag).map((row) => ({ ...row, id: row.id }))

  // Nothing carried is worth saying; nothing in the catalogue means the item
  // table could not be read, which is a different sentence.
  const emptyEl = $('bagEmpty')
  emptyEl.hidden = rows.length > 0
  emptyEl.textContent = showEverything
    ? t('The item list could not be read from this build.')
    : t('Nothing carried yet.')
  // The column names have nothing to name over an empty list.
  $('bagHead').hidden = rows.length === 0
  $('bagLabelsSubmit').hidden = rows.length === 0

  for (const row of rows) {
    const el = document.createElement('div')
    el.className = 'bag-row'

    const sell = bagMarkCheckbox('Sell', row.label, stagedLabels.sellable.has(row.id), (checked) => {
      if (checked) stagedLabels.sellable.add(row.id)
      else stagedLabels.sellable.delete(row.id)
    })
    const drop = bagMarkCheckbox('Drop', row.label, stagedLabels.dropable.has(row.id), (checked) => {
      if (checked) stagedLabels.dropable.add(row.id)
      else stagedLabels.dropable.delete(row.id)
    })

    const name = document.createElement('span')
    name.className = 'bag-name'
    name.textContent = row.label
    if (row.locked) {
      const lock = document.createElement('span')
      lock.className = 'bag-lock'
      lock.title = t('Locked')
      lock.innerHTML = LOCK_ICON
      name.prepend(lock)
    }
    const qty = document.createElement('span')
    qty.className = 'bag-qty'
    // A zero in catalogue mode is "you do not have this", which the blank
    // says more quietly than "×0" does.
    qty.textContent = row.quantity > 0 ? `×${row.quantity}` : ''
    el.append(sell, drop, name, qty)
    box.appendChild(el)
  }
}

/// The catalogue toggle. Marks are per item_def_id and the agent reads them
/// from a file, so there is nothing about them that needs the item to be in
/// the bag — but the only way to reach a checkbox was to be holding the
/// thing, which is backwards for a dungeoneer deciding in advance what it
/// may bin.
export async function setShowEverything(on) {
  showEverything = Boolean(on)
  if (showEverything) await loadItemCatalogue()
  drawRows()
}

export async function submitBagLabels(characterId, characterName) {
  if (!characterId) {
    $('bagLabelsStatus').textContent = t('No character selected.')
    return
  }
  try {
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
