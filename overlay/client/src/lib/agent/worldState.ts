/// Turns what the client already knows into the text the model reads. Nothing
/// here queries the server: the agent sees exactly what the player's own
/// screen shows, which is what "same interface as a human" has to mean.

import { get } from 'svelte/store'

import { gameStore } from '../stores/gameStore'
import { inventoryStore, playerGold } from '../stores/inventoryStore'
import { serverGameTime } from '../stores/timeStore'
import { monsterManager } from '../managers/monsterManager'
import { remotePlayerManager } from '../managers/remotePlayerManager'
import { groundItemManager } from '../managers/groundItemManager'
import { getItemDef } from '../data/itemDefs'

/// Beyond this the model is reading about things it cannot reach this turn.
const SIGHT_RANGE = 40
const MAX_LISTED = 8
const RECENT_EVENTS = 12

interface Vec {
  x: number
  z: number
}

function distance(a: Vec, b: Vec): number {
  const dx = a.x - b.x
  const dz = a.z - b.z
  return Math.sqrt(dx * dx + dz * dz)
}

/// Compass bearing, because "north-east, 12m" is a direction a model can act
/// on and a raw coordinate pair is not.
function bearing(from: Vec, to: Vec): string {
  const dx = to.x - from.x
  const dz = to.z - from.z
  const names = [
    'north',
    'northeast',
    'east',
    'southeast',
    'south',
    'southwest',
    'west',
    'northwest',
  ]
  // -Z is north in this world; atan2 gives the clockwise index from there.
  const angle = Math.atan2(dx, -dz)
  const index =
    Math.round(((angle + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)) % 8
  return names[index]
}

function near<T extends { position: Vec }>(
  self: Vec,
  items: T[]
): { item: T; dist: number }[] {
  return items
    .map((item) => ({ item, dist: distance(self, item.position) }))
    .filter((entry) => entry.dist <= SIGHT_RANGE)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, MAX_LISTED)
}

function itemName(defId: string): string {
  return getItemDef(defId)?.name ?? defId
}

export function buildWorldState(): string {
  const state = get(gameStore)
  const me = state.currentPlayer
  if (!me) return 'You are not in the world yet.'

  const self: Vec = { x: me.position.x, z: me.position.z }
  const lines: string[] = []

  const time = get(serverGameTime)
  const clock = time
    ? `${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}${time.isNight ? ' (night)' : ''}`
    : 'unknown'

  lines.push(
    `You: ${me.name}, level ${me.level} ${me.characterClass}, ` +
      `${me.health}/${me.maxHealth} HP, ${get(playerGold)} gold.`,
    `Position: x ${self.x.toFixed(1)}, z ${self.z.toFixed(1)}. Time: ${clock}.`
  )

  // Remote players carry no position of their own — that lives in the
  // interpolator, which is also what the screen is drawing.
  const players = near(
    self,
    [...state.otherPlayers.values()].flatMap((p) => {
      const live = remotePlayerManager.players.get(p.id)
      if (!live) return []
      return [
        {
          position: { x: live.position.x, z: live.position.z },
          name: p.name,
          isNpc: p.isOfficialNpc,
        },
      ]
    })
  )
  if (players.length) {
    lines.push('People nearby:')
    for (const { item, dist } of players) {
      lines.push(
        `  - ${item.name}${item.isNpc ? ' (NPC)' : ''}, ${dist.toFixed(0)}m ${bearing(self, item.position)}`
      )
    }
  }

  const monsters = near(
    self,
    [...monsterManager.monsters.values()]
      .filter((m) => m.state !== 'dead')
      .map((m) => ({
        position: { x: m.position.x, z: m.position.z },
        id: m.id,
        type: m.type,
        health: m.health,
        maxHealth: m.maxHealth,
      }))
  )
  if (monsters.length) {
    lines.push('Monsters nearby:')
    for (const { item, dist } of monsters) {
      lines.push(
        `  - ${item.type} [id ${item.id}] ${item.health}/${item.maxHealth} HP, ` +
          `${dist.toFixed(0)}m ${bearing(self, item.position)}`
      )
    }
  }

  const ground = near(
    self,
    [...groundItemManager.items.values()].map((g) => ({
      position: { x: g.position.x, z: g.position.z },
      instanceId: g.instanceId,
      defId: g.itemDefId,
    }))
  )
  if (ground.length) {
    lines.push('Items on the ground:')
    for (const { item, dist } of ground) {
      lines.push(
        `  - ${itemName(item.defId)} [id ${item.instanceId}], ${dist.toFixed(0)}m ${bearing(self, item.position)}`
      )
    }
  }

  const bag = get(inventoryStore).bag ?? []
  lines.push(
    bag.length
      ? `Bag: ${bag.map((i) => itemName(i.item_def_id)).join(', ')}`
      : 'Bag: empty'
  )

  const events = [...state.chatMessages, ...state.combatMessages]
    .slice(-RECENT_EVENTS)
    .map((entry) => (entry.name ? `${entry.name}: ${entry.text}` : entry.text))
  if (events.length) {
    lines.push('Recent events:')
    for (const event of events) lines.push(`  ${event}`)
  }

  return lines.join('\n')
}
