'use strict'

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

/// The character XP curve, ported from shared/src/xp.rs: cumulative XP for a
/// level is `20 · 2^(n-2)`, and level 1 starts at 0.
function xpForLevel(level) {
  return level <= 1 ? 0 : 20 * 2 ** (level - 2)
}

/// How far into the current level the character is, 0–100.
export function xpProgressPct({ level, xp }) {
  const start = xpForLevel(level)
  const next = xpForLevel(level + 1)
  return Math.max(0, Math.min(100, ((xp - start) / (next - start)) * 100))
}

export function dutyState(running, phase, retryMs) {
  if (!running) return { label: 'Off duty', tone: 'off' }
  if (phase === 'retrying') {
    const secs = Math.ceil(Math.max(0, retryMs || 0) / 1000)
    return { label: secs ? `Retrying in ${secs}s` : 'Retrying', tone: 'bad' }
  }
  return { label: PHASE_WORDS[phase] || 'On duty', tone: PHASE_TONES[phase] || 'live' }
}
