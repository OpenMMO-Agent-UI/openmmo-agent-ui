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

/// The hunger bands the server judges (shared/src/hunger.rs), in the words a
/// player acts on: what the character can still do is the news, not the band's
/// internal name. `warn` is the band that has already cost the sprint; `bad`
/// is the one that slows every swing and stops natural healing.
const HUNGER_BANDS = {
  Normal: { label: 'Fed', tone: 'ok' },
  Hungry: { label: 'Hungry · no sprint', tone: 'warn' },
  Weak: { label: 'Weak · slowed', tone: 'bad' },
}

/// The header's food bar and the sheet's hunger line, from one reading.
/// Satiation is owner-private and only reaches us once the character is in the
/// world, so an absent reading means "no bar", not "empty".
export function hungerReading(hunger) {
  if (!hunger || !Number.isFinite(hunger.satiation)) return null
  const max = hunger.max || 1000
  const band = HUNGER_BANDS[hunger.band] || HUNGER_BANDS.Normal
  return {
    pct: Math.max(0, Math.min(100, (hunger.satiation / max) * 100)),
    text: `${hunger.satiation}/${max}`,
    label: t(band.label),
    tone: band.tone,
  }
}

/// The six rolled attributes in the order the game rolls them
/// (shared/src/character.rs CharacterAttributes). Guard is not one of them —
/// it is what armour adds up to — so it reads on its own line in the sheet.
const ATTRIBUTE_ORDER = ['str', 'dex', 'con', 'int', 'wis', 'cha']

export function attributeCells(attributes) {
  if (!attributes) return []
  return ATTRIBUTE_ORDER.filter((key) => Number.isFinite(attributes[key])).map((key) => ({
    key,
    label: key.toUpperCase(),
    value: attributes[key],
  }))
}

export function dutyState(running, phase, retryMs) {
  if (!running) return { label: t('Off duty'), tone: 'off' }
  if (phase === 'retrying') {
    const secs = Math.ceil(Math.max(0, retryMs || 0) / 1000)
    return { label: secs ? t('Retrying in {secs}s', { secs }) : t('Retrying'), tone: 'bad' }
  }
  return { label: t(PHASE_WORDS[phase] || 'On duty'), tone: PHASE_TONES[phase] || 'live' }
}
