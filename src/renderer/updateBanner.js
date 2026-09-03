'use strict'

import { $ } from './dom.js'
import { t } from './i18n.js'

/// What the banner says for each updater state, and which buttons go with
/// it. Split out from the DOM so the wording — the only part with any
/// judgement in it — is testable. `null` means show nothing: a check that
/// found nothing, or a failed check with no update pending, is not news.
export function bannerFor(state) {
  const version = state?.version ? `v${state.version}` : t('A new version')
  if (state?.status === 'ready') {
    return { text: t('{version} is ready to install.', { version }), restart: true, download: false }
  }
  if (state?.status === 'error') {
    return {
      text: t('{version} could not install automatically.', { version }),
      restart: false,
      download: true,
    }
  }
  return null
}

/// The Settings line, which reports every state including the quiet ones.
export function statusLine(state) {
  switch (state?.status) {
    case 'checking':
      return t('Checking for updates…')
    case 'downloading':
      return t('Downloading v{version}…', { version: state.version ?? '…' })
    case 'ready':
      return t('v{version} is ready — restart to install.', { version: state.version })
    case 'error':
      return t('Automatic update failed. Download the new version manually.')
    case 'disabled':
      return t('Updates are off in a development build.')
    default:
      return t('Up to date. Updates install automatically.')
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

  $('updateRestart').addEventListener('click', async () => {
    const res = await api.installUpdate()
    // The install can legitimately refuse (macOS app outside /Applications):
    // say why in the Settings line instead of pretending the click did nothing.
    if (!res?.ok) {
      $('updateStatus').textContent = res?.error || t('The update could not be installed.')
    }
  })
  $('updateDownload').addEventListener('click', () => void api.openDownloadPage())
  $('updateDismiss').addEventListener('click', () => {
    dismissed = last?.version ?? null
    $('updateBanner').hidden = true
  })
  $('updateCheck').addEventListener('click', async () => {
    $('updateStatus').textContent = t('Checking for updates…')
    render(await api.checkUpdate())
  })
  api.onUpdateState(render)
  return render
}
