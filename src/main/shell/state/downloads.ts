import { throttleChanges } from '../../downloads/change-throttle.js'
import { attentionFor, startedThisRun } from '../../downloads/window-attention.js'
import type { ShellStatePart } from '../shell-state-parts.js'
import type { DownloadsButtonState } from '../tab-types.js'

/** `toolbar.downloads`: `auto` shows the button once this run has downloaded something, or while a download runs. */
export const downloadsStatePart: ShellStatePart = {
  name: 'downloads',
  read: ({ services, window }, tabs) => {
    const { downloads, settings } = services
    const { active, fraction, any } = downloads.summary()
    const attention = attentionFor(window, downloads)
    // The Downloads page in front is looking at everything the dot would point to.
    if (tabs.tabs.find((tab) => tab.id === tabs.activeTabId)?.url.startsWith('orivon://downloads') === true) attention.seen()
    const mode = settings.get('toolbar.downloads')
    const shown = mode === 'always' || (mode === 'auto' && (active > 0 || (any && startedThisRun(downloads))))
    const state: DownloadsButtonState = { shown, active, fraction, paused: active > 0 && attention.pausedOnly, attention: attention.value() }
    return { downloads: state }
  },
  // Progress arrives many times a second; the chrome hears of it a few times.
  watch: ({ services, window }, push) => {
    const { downloads, settings } = services
    const attention = attentionFor(window, downloads)
    startedThisRun(downloads)
    const pushSoon = throttleChanges(() => { push() })
    const stopDownloads = downloads.onChange((change) => { attention.note(change); pushSoon(change) })
    const stopSettings = settings.onChange(({ key }) => { if (key === 'toolbar.downloads') push() })
    return () => { stopDownloads(); stopSettings(); pushSoon.cancel() }
  }
}
