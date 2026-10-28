// Looks for a newer release and tells the person in the window in use: the look at start, every hour, and when the
// setting is switched on, and, while a release waits for a window, a retry every few seconds. Not in a private session,
// nor in a Microsoft Store install, which the Store updates itself.
import type { ShellInstaller } from '../shell/shell-installers.js'
import { RETRY_MS } from '../os/install-default-browser-ask.js'
import { isStoreInstall } from '../os/windows-store.js'
import { scheduleUpdateChecks, updateChecksEnabled, updateChecksForcedOff } from './update-schedule.js'
import { exposeUpdateCheckNow } from './update-test-seam.js'

export const installUpdateNotice: ShellInstaller = {
  name: 'update-notice',
  install: (app, services, _ctx, runtime) => {
    if (runtime.isPrivate || isStoreInstall()) return
    const notice = services.browserUpdate
    const lookAllowed = (): boolean => services.settings.get('updates.check')
    exposeUpdateCheckNow(async () => { await notice.runScheduled() })

    let retry: ReturnType<typeof setInterval> | undefined
    const followWaiting = (): void => {
      // A kiosk is told through Settings only, so it has nothing to retry.
      const waiting = notice.offer()?.pending === true && !services.kiosk
      if (waiting && retry === undefined) {
        retry = setInterval(() => {
          if (lookAllowed()) notice.tryAsk().catch((error: unknown) => { console.error('[self-update] the question failed:', error) })
        }, RETRY_MS)
        retry.unref()
      } else if (!waiting && retry !== undefined) {
        clearInterval(retry)
        retry = undefined
      }
    }
    const stopListening = notice.onChange(followWaiting)

    const stopSchedule = scheduleUpdateChecks({
      enabled: () => updateChecksEnabled(lookAllowed(), isStoreInstall(), updateChecksForcedOff()),
      onEnabledChange: (listener) => services.settings.onChange((change) => { if (change.key === 'updates.check') listener() }),
      run: async () => { await notice.runScheduled() }
    })
    app.once('will-quit', () => {
      stopSchedule()
      stopListening()
      if (retry !== undefined) clearInterval(retry)
    })
  }
}
