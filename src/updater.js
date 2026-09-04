'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { app, shell } = require('electron')

const telemetry = require('./telemetry')
const { t } = require('./i18n')

/// The public mirror the app updates from. This repository is private, so its
/// own release assets are not anonymously reachable; publish-downloads.yml
/// mirrors every published release to the wiki repo and prunes the previous
/// one, which makes GitHub's `releases/latest/download/` a stable base URL
/// even though the tags and filenames carry the version.
///
/// Set here rather than left to the `app-update.yml` electron-builder writes
/// from package.json's `build.publish`: that block is there to make the build
/// emit the latest*.yml channel files at all, and pointing the running app at
/// a URL it states out loud beats depending on a generated file being present.
const FEED_URL = 'https://github.com/OpenMMO-Agent-UI/openmmo-agent-wiki/releases/latest/download'
const DOWNLOAD_PAGE = 'https://openmmo-agent-ui.github.io/openmmo-agent-wiki/client/install/'

/// The server matches the protocol version exactly, so a client that falls
/// behind cannot play at all — and releases go out most days. Hourly keeps a
/// machine that is left running overnight from waking up unable to connect.
const CHECK_INTERVAL_MS = 60 * 60 * 1000

/// The same last resort `before-quit` keeps: a wedged agent-client must not be
/// able to make the app unquittable, and it must not be able to make "Restart
/// to update" hang either — without this, install() waits on stopAgent()
/// forever and the click looks like it did nothing at all.
const STOP_AGENT_TIMEOUT_MS = 8000

/// Comfortably past the longest legitimate quit (the agent's 8s, then the
/// installer handing over), because on the happy path this app is gone before
/// it fires. See install() for what it is watching for.
const INSTALL_TIMEOUT_MS = 20000

/// Squirrel.Mac replaces the app bundle in place, and only when the app is
/// running from a standard Applications folder; a copy launched from anywhere
/// else (Downloads, an extracted zip, the DMG itself) makes the native updater
/// fail silently — the app quits on install and nothing replaces it. These
/// helpers exist so install() can detect that and say so instead of trusting a
/// ghost update. Pure for tests: both take their inputs instead of reaching
/// for app.
function macBundlePath(exePath = app.getPath('exe'), platform = process.platform) {
  if (platform !== 'darwin' || !exePath) return null
  const parts = String(exePath).split(path.sep)
  const appIndex = parts.findIndex((part) => part.endsWith('.app'))
  return appIndex === -1 ? null : parts.slice(0, appIndex + 1).join(path.sep)
}

function inApplicationsFolder(
  exePath = app.getPath('exe'),
  homePath = app.getPath('home'),
  platform = process.platform
) {
  const bundle = macBundlePath(exePath, platform)
  if (!bundle) return true
  const apps = [path.join('/', 'Applications'), path.join(homePath, 'Applications')]
  const needle = bundle.toLowerCase()
  return apps.some((dir) => needle === dir.toLowerCase() || needle.startsWith(dir.toLowerCase() + path.sep))
}

/// Big enough to hold weeks of hourly checks, small enough that a runaway
/// never becomes the largest file in userData.
const LOG_MAX_BYTES = 256 * 1024

/// electron-updater logs to `console`, which for a packaged app launched from
/// the Finder goes nowhere at all. After an update that did not happen, the
/// only question worth asking is what the updater actually did, and without
/// this there is no way to answer it — not from a user's machine, and not
/// from ours. install()'s own decisions go here too: the refusals and the
/// timeouts are exactly the part electron-updater cannot see.
function openLog() {
  let file
  try {
    file = path.join(app.getPath('userData'), 'update.log')
    if (fs.existsSync(file) && fs.statSync(file).size > LOG_MAX_BYTES) fs.rmSync(file)
  } catch {
    return null
  }
  const write = (level, message) => {
    try {
      fs.appendFileSync(file, `${new Date().toISOString()} ${level} ${message}\n`)
    } catch {
      // A log that cannot be written must never take the updater down with it.
    }
  }
  return {
    file,
    info: (m) => write('info', m),
    warn: (m) => write('warn', m),
    error: (m) => write('error', m),
  }
}

let log = null
let updater = null
let stopAgent = async () => {}
let publish = () => {}
let timer = null
let installWatchdog = null
let state = { status: 'disabled', version: null, kind: null, percent: null, message: null }

/// A category, never the message: the raw text carries URLs and local paths,
/// and this goes to analytics. Enough to tell "nobody can reach the feed"
/// from "the AppImage is read-only" without shipping either.
function errorKind(err) {
  const text = String((err && err.message) || err || '')
  if (/sha512|checksum|integrity/i.test(text)) return 'integrity'
  if (/signature|code ?sign|notariz/i.test(text)) return 'signature'
  if (/EACCES|EPERM|EROFS|read-only|APPIMAGE/i.test(text)) return 'permission'
  if (/ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|net::|socket hang up|HttpError|status code/i.test(text)) return 'net'
  return 'other'
}

function setState(next) {
  state = { ...state, ...next }
  publish(state)
}

/// A downloaded build outlives every check that comes after it. The hourly
/// re-check walks checking → available → downloaded again, an offline hour
/// raises an error, and a feed hiccup answers not-available — and each of
/// those, written straight into the status, retires an update that is sitting
/// on disk ready to go. The restart button disappears from Settings and
/// install() then refuses with nothing to say, which is exactly what "Restart
/// to update does nothing" looks like from the outside. So once a build is
/// ready, only a genuinely different version may take the status back.
function holdsDownload(current, version) {
  if (current.status === 'installing') return true
  return current.status === 'ready' && (version == null || version === current.version)
}

/// The whole state machine as one pure function — `event` is the
/// electron-updater event name, `payload` its argument — so the rule above
/// can be tested without a packaged app behind it. `null` means the event
/// changes nothing.
function reduce(current, event, payload) {
  switch (event) {
    case 'checking-for-update':
      return holdsDownload(current) ? null : { status: 'checking', kind: null, percent: null, message: null }
    case 'update-not-available':
      return holdsDownload(current)
        ? null
        : { status: 'idle', version: null, kind: null, percent: null, message: null }
    case 'update-available': {
      const version = payload?.version ?? null
      return holdsDownload(current, version)
        ? null
        : { status: 'downloading', version, kind: null, percent: null, message: null }
    }
    // The only measure of a download the app has. Without it a 100 MB build
    // is a status line reading "Downloading…" for minutes and nothing else.
    case 'download-progress': {
      if (holdsDownload(current)) return null
      const percent = Number(payload?.percent)
      return {
        status: 'downloading',
        percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, Math.round(percent))) : null,
      }
    }
    case 'update-downloaded': {
      const version = payload?.version ?? current.version
      // Re-downloading what is already on disk is the hourly check finding
      // the same build again; a refusal recorded against it still stands.
      if (holdsDownload(current, version)) return null
      return { status: 'ready', version, kind: null, percent: 100, message: null }
    }
    // A failed check with nothing pending is just a machine that is offline;
    // only a download that was going somewhere earns the manual fallback. An
    // install that failed after the fact still has the build on disk, so it
    // falls back to ready rather than throwing the download away.
    case 'error': {
      const kind = errorKind(payload)
      if (current.status === 'installing') return { status: 'ready', kind }
      if (holdsDownload(current)) return { kind }
      return { status: current.status === 'downloading' ? 'error' : 'idle', kind }
    }
    default:
      return null
  }
}

function apply(event, payload) {
  const next = reduce(state, event, payload)
  if (next) setState(next)
}

/// This module's own line in the updater's log, tagged so it reads apart from
/// electron-updater's.
function note(message) {
  if (log) log.info(`[updater] ${message}`)
}

function init({ send, stopAgent: stop }) {
  publish = (value) => send('update:state', value)
  stopAgent = stop
  // A dev checkout has no update to install and electron-updater throws
  // rather than no-op, so it never gets wired up at all.
  if (!app.isPackaged) return
  try {
    updater = require('electron-updater').autoUpdater
  } catch {
    return
  }
  log = openLog()
  if (log) updater.logger = log
  note(`app ${app.getVersion()} on ${process.platform}, exe ${app.getPath('exe')}`)
  updater.autoDownload = true
  updater.autoInstallOnAppQuit = true
  updater.setFeedURL({ provider: 'generic', url: FEED_URL })

  for (const event of ['checking-for-update', 'update-not-available', 'update-available', 'download-progress']) {
    updater.on(event, (payload) => apply(event, payload))
  }
  updater.on('update-downloaded', (info) => {
    const fresh = state.status !== 'ready'
    apply('update-downloaded', info)
    if (fresh) telemetry.track('update_downloaded', { version: state.version || 'unknown' })
  })
  updater.on('error', (err) => {
    apply('error', err)
    telemetry.track('update_error', { kind: errorKind(err) })
  })

  setState({ status: 'idle' })
  void check()
  timer = setInterval(() => void check(), CHECK_INTERVAL_MS)
  if (timer.unref) timer.unref()
}

async function check() {
  if (!updater) return state
  try {
    await updater.checkForUpdates()
  } catch {
    // Already reported through the error event above.
  }
  return state
}

/// Kills agent-client and waits for it to actually be gone before handing
/// over to the installer. On Windows the NSIS installer starts as soon as
/// quitAndInstall() is called, and a live child process holds a lock on the
/// files it is trying to replace — the install then fails silently and the
/// user stays on the old version forever.
async function install() {
  // Every refusal carries the sentence that explains it. `{ ok: false }` on
  // its own reaches the user as "The update could not be installed." with no
  // reason and no way forward, which is worse than no answer at all.
  if (!updater) return refuse(t('Updates are off in a development build.'))
  if (state.status === 'installing') return { ok: true }
  if (state.status !== 'ready') return refuse(t('There is no downloaded update waiting yet.'))
  // Squirrel.Mac only replaces an app inside an Applications folder; calling
  // quitAndInstall() from anywhere else makes the update vanish — the app
  // quits, the bundle never changes, nothing relaunches. Refuse with a real
  // answer and let the renderer offer the manual download instead.
  if (process.platform === 'darwin' && !inApplicationsFolder()) {
    return refuse(
      t(
        'macOS can only auto-update an app inside the Applications folder. Move OpenMMO Agent UI into /Applications, then update again.',
      ),
    )
  }
  // Published before the wait, not after: stopping the agent can take seconds,
  // and until this lands every surface still shows a button that looks unclicked.
  setState({ status: 'installing', message: null, kind: null })
  note(`installing v${state.version}: stopping the agent`)
  const stopped = await Promise.race([stopAgent().then(() => true), wait(STOP_AGENT_TIMEOUT_MS)])
  note(stopped ? 'agent stopped, calling quitAndInstall' : 'agent stop timed out, calling quitAndInstall anyway')
  try {
    updater.quitAndInstall()
  } catch (err) {
    note(`quitAndInstall threw: ${err && err.message}`)
    telemetry.track('update_error', { kind: errorKind(err) })
    return refuse(t('The update could not be installed.'))
  }
  // quitAndInstall does not throw when it declines — electron-updater logs
  // and returns, and the app carries on running under a status that says it
  // is installing. Nothing else would ever take that status back, so the
  // Settings line would sit on "Installing" for the rest of the session. If
  // this app is still here long after it should have quit, it did not take.
  installWatchdog = setTimeout(() => {
    note('still running well after quitAndInstall — the install did not take')
    telemetry.track('update_error', { kind: 'stalled' })
    refuse(t('The update could not be installed.'))
  }, INSTALL_TIMEOUT_MS)
  if (installWatchdog.unref) installWatchdog.unref()
  return { ok: true }
}

/// A refused install keeps the downloaded build — the user can move the app
/// and click again — so the status goes back to what it was and carries the
/// reason, which is how the Settings line and the outdated dialog end up
/// saying the same thing.
function refuse(message) {
  note(`refused: ${message}`)
  if (state.status === 'installing' || state.status === 'ready') setState({ status: 'ready', message })
  return { ok: false, error: message }
}

function wait(ms) {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, ms)
    if (timeout.unref) timeout.unref()
  })
}

function openDownloadPage() {
  return shell.openExternal(DOWNLOAD_PAGE)
}

function current() {
  return state
}

function stop() {
  if (timer) clearInterval(timer)
  if (installWatchdog) clearTimeout(installWatchdog)
  timer = null
  installWatchdog = null
}

module.exports = {
  init,
  check,
  install,
  openDownloadPage,
  current,
  stop,
  errorKind,
  reduce,
  macBundlePath,
  inApplicationsFolder,
  FEED_URL,
  DOWNLOAD_PAGE,
}
