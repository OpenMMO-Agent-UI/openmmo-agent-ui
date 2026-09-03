'use strict'

import { $ } from './dom.js'
import { t } from './i18n.js'

/// The Settings line, which reports every state including the quiet ones.
/// A refused install replaces it: "ready" would be true and useless next to a
/// button that just declined to do anything.
export function statusLine(state) {
  switch (state?.status) {
    case 'checking':
      return t('Checking for updates…')
    case 'downloading':
      return state.percent == null
        ? t('Downloading v{version}…', { version: state.version ?? '…' })
        : t('Downloading v{version} — {percent}%', { version: state.version ?? '…', percent: state.percent })
    case 'ready':
      return state.message || t('v{version} is ready — restart to install.', { version: state.version })
    case 'installing':
      return t('Installing v{version}…', { version: state.version ?? '…' })
    case 'error':
      return t('Automatic update failed. Download the new version manually.')
    case 'disabled':
      return t('Updates are off in a development build.')
    default:
      return t('Up to date. Updates install automatically.')
  }
}

/// Which of the two shortcuts belong to a state. A downloaded build installs
/// itself on the next quit, so Restart is only ever an offer to do it sooner;
/// Download is the way out when the updater cannot finish the job — either it
/// failed outright, or it refused this install and said why.
export function controlsFor(state) {
  return {
    restart: state?.status === 'ready',
    download: state?.status === 'error' || (state?.status === 'ready' && Boolean(state.message)),
  }
}

/// Paints the outdated dialog's rule: a bar at a known percentage, a full bar,
/// or the travelling lamp when the app knows something is happening but not
/// how far along it is.
export function paintRule(fill, progress) {
  const indeterminate = progress === 'indeterminate'
  fill.classList.toggle('indeterminate', indeterminate)
  if (indeterminate) fill.style.removeProperty('width')
  else fill.style.width = progress === 'full' ? '100%' : `${Math.max(0, Math.min(100, Number(progress) || 0))}%`
}

export function mount(api) {
  const render = (state) => {
    $('updateStatus').textContent = statusLine(state)
    const controls = controlsFor(state)
    $('updateRestart').hidden = !controls.restart
    $('updateDownload').hidden = !controls.download
  }

  // The updater publishes 'installing' the moment the click lands, so this
  // render hides Restart on its own; a refusal comes back through the same
  // state, carrying the reason into the line above the buttons.
  $('updateRestart').addEventListener('click', async () => {
    const res = await api.installUpdate()
    if (!res?.ok) $('updateStatus').textContent = res?.error || t('The update could not be installed.')
  })
  $('updateDownload').addEventListener('click', () => void api.openDownloadPage())
  $('updateCheck').addEventListener('click', async () => {
    $('updateStatus').textContent = t('Checking for updates…')
    render(await api.checkUpdate())
  })
  api.onUpdateState(render)
  return render
}
