/// Runs the model's chosen actions through the very controls a click uses.
/// Nothing here talks to the server directly except chat and item use: a move
/// becomes the same `request_move` a right-click produces, an attack the same
/// `attack_monster` intent, so pathfinding, chasing and range checks stay in
/// one place and the agent cannot do anything a player could not.

import { get } from 'svelte/store'

import { gameStore } from '../stores/gameStore'
import { inventoryStore } from '../stores/inventoryStore'
import { monsterManager } from '../managers/monsterManager'
import { remotePlayerManager } from '../managers/remotePlayerManager'
import { groundItemManager } from '../managers/groundItemManager'
import { getItemDef } from '../data/itemDefs'
import { networkManager } from '../network/socket'
import type { PlayerControlEvent } from '../components/player-control/events'

/// Events the agent hands to PlayerControl, drained once per frame by the
/// scene. A queue rather than a direct call because PlayerControl's actions
/// only exist inside the component's own update tick.
const queue: PlayerControlEvent[] = []

export function drainAgentEvents(): PlayerControlEvent[] {
  if (queue.length === 0) return []
  return queue.splice(0, queue.length)
}

export interface AgentAction {
  type: string
  message?: string
  monster_id?: string
  target?: string
  item?: string | number
  x?: number
  y?: number
  z?: number
  direction?: string
  distance?: number
}

const DIRECTIONS: Record<string, { x: number; z: number }> = {
  north: { x: 0, z: -1 },
  south: { x: 0, z: 1 },
  east: { x: 1, z: 0 },
  west: { x: -1, z: 0 },
  northeast: { x: 0.7071, z: -0.7071 },
  northwest: { x: -0.7071, z: -0.7071 },
  southeast: { x: 0.7071, z: 0.7071 },
  southwest: { x: -0.7071, z: 0.7071 },
}

/// Stop this far short of a person, so "walk up to X" ends in conversation
/// range instead of inside them.
const TALK_DISTANCE = 2.5

function moveTo(x: number, z: number): void {
  const me = get(gameStore).currentPlayer
  if (!me) return
  queue.push({ type: 'request_move', position: { x, y: me.position.y, z } })
}

function resolveMove(action: AgentAction): string {
  const me = get(gameStore).currentPlayer
  if (!me) return 'not in the world'

  if (action.target) {
    const wanted = action.target.toLowerCase()
    const match = [...get(gameStore).otherPlayers.values()].find(
      (p) => p.name.toLowerCase() === wanted
    )
    const live = match && remotePlayerManager.players.get(match.id)
    if (!live) return `nobody here called ${action.target}`
    const dx = live.position.x - me.position.x
    const dz = live.position.z - me.position.z
    const dist = Math.hypot(dx, dz)
    if (dist <= TALK_DISTANCE) return `already next to ${match!.name}`
    const scale = (dist - TALK_DISTANCE) / dist
    moveTo(me.position.x + dx * scale, me.position.z + dz * scale)
    return `walking to ${match!.name}`
  }

  if (action.direction) {
    const dir = DIRECTIONS[action.direction.toLowerCase()]
    if (!dir) return `unknown direction ${action.direction}`
    const dist = action.distance ?? 10
    moveTo(me.position.x + dir.x * dist, me.position.z + dir.z * dist)
    return `walking ${action.direction} ${dist}m`
  }

  if (typeof action.x === 'number' && typeof action.z === 'number') {
    moveTo(action.x, action.z)
    return `walking to ${action.x.toFixed(1)}, ${action.z.toFixed(1)}`
  }

  return 'move needs target, direction or x/z'
}

function resolveAttack(action: AgentAction): string {
  const me = get(gameStore).currentPlayer
  if (!me || !action.monster_id) return 'attack needs monster_id'
  const monster = monsterManager.monsters.get(action.monster_id)
  if (!monster || monster.state === 'dead')
    return `no monster ${action.monster_id}`
  const distance = Math.hypot(
    monster.position.x - me.position.x,
    monster.position.z - me.position.z
  )
  queue.push({
    type: 'canvas_intent',
    editorMode: false,
    intent: {
      type: 'attack_monster',
      monsterId: monster.id,
      hitPoint: { ...monster.position },
      distance,
    },
  })
  return `attacking ${monster.type}`
}

function resolvePickup(action: AgentAction): string {
  const me = get(gameStore).currentPlayer
  if (!me) return 'not in the world'
  const items = [...groundItemManager.items.values()]
  const wanted = action.item
  const target =
    typeof wanted === 'number'
      ? items.find((i) => i.instanceId === wanted)
      : items.find(
          (i) =>
            i.itemDefId === wanted ||
            getItemDef(i.itemDefId)?.name.toLowerCase() ===
              String(wanted).toLowerCase()
        )
  if (!target) return `no such item on the ground: ${wanted}`
  queue.push({
    type: 'canvas_intent',
    editorMode: false,
    intent: {
      type: 'pickup_ground_item',
      instanceId: target.instanceId,
      position: { ...target.position },
      distance: Math.hypot(
        target.position.x - me.position.x,
        target.position.z - me.position.z
      ),
    },
  })
  return `picking up ${getItemDef(target.itemDefId)?.name ?? target.itemDefId}`
}

function resolveUse(action: AgentAction): string {
  const wanted = String(action.item ?? '').toLowerCase()
  if (!wanted) return 'use needs an item'
  const bag = get(inventoryStore).bag ?? []
  const match = bag.find(
    (i) =>
      i.item_def_id.toLowerCase() === wanted ||
      (getItemDef(i.item_def_id)?.name ?? '').toLowerCase() === wanted
  )
  if (!match) return `not carrying ${action.item}`
  networkManager.sendUseItem(match.instance_id)
  return `using ${getItemDef(match.item_def_id)?.name ?? match.item_def_id}`
}

/// Returns a short line per action for the thought feed, so a run that did
/// nothing says why instead of looking like the model went quiet.
export function runActions(actions: AgentAction[]): string[] {
  const log: string[] = []
  for (const action of actions.slice(0, 4)) {
    switch (action.type) {
      case 'say':
        if (action.message) {
          networkManager.sendChatMessage(action.message)
          log.push(`say: ${action.message}`)
        }
        break
      case 'move':
        log.push(resolveMove(action))
        break
      case 'attack':
        log.push(resolveAttack(action))
        break
      case 'pickup':
        log.push(resolvePickup(action))
        break
      case 'use':
        log.push(resolveUse(action))
        break
      case 'respawn':
        networkManager.requestRespawn()
        log.push('respawning')
        break
      case 'wait':
        log.push('waiting')
        break
      default:
        log.push(`unsupported action: ${action.type}`)
    }
  }
  return log
}
