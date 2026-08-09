'use strict'

/// Anonymous usage analytics via Aptabase (aptabase.com — open source,
/// privacy-first, built for desktop apps). What leaves the machine per event:
/// the event name, the props passed here, app version, OS name/version, and a
/// short-lived random session id. Nothing else — no account, no character
/// names, no prompts, no server URLs, no persistent device id.
///
/// Every call is gated on the `telemetry` setting (default on, Settings →
/// Display → Privacy turns it off), checked at send time so flipping the
/// toggle takes effect immediately. All failures are swallowed: analytics
/// must never take the app down or even write a scary log line.

const APTABASE_APP_KEY = 'A-US-1292822767'

let aptabase = null
let getEnabled = () => true

function init(isEnabled) {
  getEnabled = isEnabled
  try {
    // Required even when the toggle is off at startup: the user can turn
    // telemetry back on mid-session, and initialize() only registers the
    // sender — it does not emit an event by itself.
    aptabase = require('@aptabase/electron/main')
    void aptabase.initialize(APTABASE_APP_KEY).catch(() => {})
  } catch {
    aptabase = null
  }
}

function track(eventName, props) {
  if (!aptabase) return
  try {
    if (!getEnabled()) return
    void aptabase.trackEvent(eventName, props).catch(() => {})
  } catch {
    // Never let analytics surface as an app error.
  }
}

module.exports = { init, track }
