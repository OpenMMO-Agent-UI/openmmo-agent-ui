'use strict'

import { $ } from './dom.js'

/// What the banner says for each updater state, and which buttons go with
/// it. Split out from the DOM so the wording — the only part with any
/// judgement in it — is testable. `null` means show nothing: a check that
/// found nothing, or a failed check with no update pending, is not news.
export function bannerFor(state) {
  const version = state?.version ? `v${state.version}` : 'A new version'
  if (state?.status === 'ready') {
    return { text: `${version} is ready to install.`, restart: true, download: false }
  }
  if (state?.status === 'error') {
    return { text: `${version} could not install automatically.`, restart: false, download: true }
  }
  return null
}

/// The Settings line, which reports every state including the quiet ones.
export function statusLine(state) {
  switch (state?.status) {
    case 'checking':
      return 'Checking for updates…'
    case 'downloading':
      return `Downloading v${state.version ?? '…'}…`
    case 'ready':
      return `v${state.version} is ready — restart to install.`
    case 'error':
      return 'Automatic update failed. Download the new version manually.'
    case 'disabled':
      return 'Updates are off in a development build.'
    default:
      return 'Up to date. Updates install automatically.'
  }
}

export function mount(api) {
  let last = null
  let dismissed = null

  const render = (state) => {
    last = state
    $('updateStatus').textContent = statusLine(state)
    const banner = bannerFor(state)
    const box = $('updateBanner')
    // Dismissal is per version: the next release has to get past the user
    // again, or one impatient click would silence updates forever.
    if (!banner || dismissed === (state?.version ?? null)) {
      box.hidden = true
      return
    }
    $('updateBannerText').textContent = banner.text
    $('updateRestart').hidden = !banner.restart
    $('updateDownload').hidden = !banner.download
    box.hidden = false
  }

  $('updateRestart').addEventListener('click', () => void api.installUpdate())
  $('updateDownload').addEventListener('click', () => void api.openDownloadPage())
  $('updateDismiss').addEventListener('click', () => {
    dismissed = last?.version ?? null
    $('updateBanner').hidden = true
  })
  $('updateCheck').addEventListener('click', async () => {
    $('updateStatus').textContent = 'Checking for updates…'
    render(await api.checkUpdate())
  })
  api.onUpdateState(render)
  return render
}
