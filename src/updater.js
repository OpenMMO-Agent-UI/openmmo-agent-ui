'use strict'

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

/// Squirrel.Mac replaces the app bundle in place, and only when the app is
/// running from a standard Applications folder; a copy launched from anywhere
/// else (Downloads, an extracted zip, the DMG itself) makes the native updater
/// fail silently — the app quits on install and nothing replaces it. These
/// helpers exist so install() can detect that and say so instead of trusting a
/// ghost update. Pure for tests: both take their inputs instead of reaching
/// for app.
function macBundlePath(exePath = app.getPath('exe')) {
  if (process.platform !== 'darwin' || !exePath) return null
  const parts = String(exePath).split(path.sep)
  const appIndex = parts.findIndex((part) => part.endsWith('.app'))
  return appIndex === -1 ? null : parts.slice(0, appIndex + 1).join(path.sep)
}

function inApplicationsFolder(exePath = app.getPath('exe'), homePath = app.getPath('home')) {
  const bundle = macBundlePath(exePath)
  if (!bundle) return true
  const apps = [path.join('/', 'Applications'), path.join(homePath, 'Applications')]
  const needle = bundle.toLowerCase()
  return apps.some((dir) => needle === dir.toLowerCase() || needle.startsWith(dir.toLowerCase() + path.sep))
}

let updater = null
let stopAgent = async () => {}
let publish = () => {}
let timer = null
let state = { status: 'disabled', version: null, kind: null }

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
  updater.autoDownload = true
  updater.autoInstallOnAppQuit = true
  updater.setFeedURL({ provider: 'generic', url: FEED_URL })

  updater.on('checking-for-update', () => setState({ status: 'checking', kind: null }))
  updater.on('update-not-available', () => setState({ status: 'idle', version: null, kind: null }))
  updater.on('update-available', (info) => setState({ status: 'downloading', version: info?.version ?? null, kind: null }))
  updater.on('update-downloaded', (info) => {
    setState({ status: 'ready', version: info?.version ?? state.version })
    telemetry.track('update_downloaded', { version: state.version || 'unknown' })
  })
  updater.on('error', (err) => {
    const kind = errorKind(err)
    // A failed check with nothing pending is just a machine that is offline;
    // only a download that was going somewhere earns the fallback banner.
    setState({ status: state.status === 'downloading' ? 'error' : 'idle', kind })
    telemetry.track('update_error', { kind })
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
  if (!updater || state.status !== 'ready') return { ok: false }
  // Squirrel.Mac only replaces an app inside an Applications folder; calling
  // quitAndInstall() from anywhere else makes the update vanish — the app
  // quits, the bundle never changes, nothing relaunches. Refuse with a real
  // answer and let the renderer offer the manual download instead.
  if (process.platform === 'darwin' && !inApplicationsFolder()) {
    return {
      ok: false,
      error: t(
        'macOS can only auto-update an app inside the Applications folder. Move OpenMMO Agent UI into /Applications, then update again.',
      ),
    }
  }
  await stopAgent()
  updater.quitAndInstall()
  return { ok: true }
}

function openDownloadPage() {
  return shell.openExternal(DOWNLOAD_PAGE)
}

function current() {
  return state
}

function stop() {
  if (timer) clearInterval(timer)
  timer = null
}

module.exports = {
  init,
  check,
  install,
  openDownloadPage,
  current,
  stop,
  errorKind,
  macBundlePath,
  inApplicationsFolder,
  FEED_URL,
  DOWNLOAD_PAGE,
}
