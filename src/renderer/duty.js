'use strict'

import { t } from './i18n.js'

/// What the header's state word says, in one place. Two callers used to write
/// that slot with two different vocabularies: setStatus wrote "running (pid
/// 4213)" or "stopped" off the agent process, applyPlayState wrote the raw
/// play-session phase ("active", "retrying · retry in 4s") — so the same line
/// changed language depending on which event fired last. The process is what
/// decides whether the character is on duty at all; the session phase only
/// refines what it is doing while it is up.

/// playSession.js's phases (src/playSession.js), in the app's own words.
/// `active` and an unmapped phase both read "On duty": the process is up.
const PHASE_WORDS = {
  starting: 'Starting',
  switching: 'Switching',
  disconnected: 'Disconnected',
}

/// `bad` is for a state a person may need to act on, `live` for a session
/// doing its job — the lamp says on/off, the tone says whether that is fine.
const PHASE_TONES = {
  disconnected: 'bad',
  retrying: 'bad',
}

/// The six rolled attributes in the order the game rolls them
/// (shared/src/character.rs CharacterAttributes), then guard — not rolled but
/// read the same way, since what the character is wearing adds to it.
const ATTRIBUTE_ORDER = ['str', 'dex', 'con', 'int', 'wis', 'cha', 'guard']

/// `effective` is the server's own reading of the two attributes gear moves
/// (proxy.js statsFromEffective) — the value is what the game acts on, and
/// `bonus` is how much of it the character is wearing rather than rolled.
export function attributeCells(attributes, effective) {
  if (!attributes) return []
  return ATTRIBUTE_ORDER.filter((key) => Number.isFinite(attributes[key])).map((key) => {
    const rolled = attributes[key]
    const value = Number.isFinite(effective?.[key]) ? effective[key] : rolled
    return { key, label: key.toUpperCase(), value, bonus: value - rolled }
  })
}

export function dutyState(running, phase, retryMs) {
  if (!running) return { label: t('Off duty'), tone: 'off' }
  if (phase === 'retrying') {
    const secs = Math.ceil(Math.max(0, retryMs || 0) / 1000)
    return { label: secs ? t('Retrying in {secs}s', { secs }) : t('Retrying'), tone: 'bad' }
  }
  return { label: t(PHASE_WORDS[phase] || 'On duty'), tone: PHASE_TONES[phase] || 'live' }
}
