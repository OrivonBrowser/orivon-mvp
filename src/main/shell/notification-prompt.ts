// "<site> wants to show notifications", asked the first time a site calls
// Notification.requestPermission(). The site comes first, as the line the
// person judges the question by. Attached to the window showing the page,
// and asynchronous: the main process keeps serving every other tab.
import { dialog, type BaseWindow } from 'electron'
import { formatOriginForDisplay } from '../consent/grant-prompt-origin.js'
import type { NotificationAnswer } from '../sessions/site-notifications.js'

/** Button order is the answer order: index 0 is Allow. */
const ANSWERS: readonly NotificationAnswer[] = ['allow', 'block', 'dismiss']
const NOT_NOW = 2

/** Enter and Escape both mean "not now": no decision, never an allow. */
export async function askNotificationPermission (window: BaseWindow, origin: string): Promise<NotificationAnswer> {
  if (window.isDestroyed()) return 'dismiss'
  const site = formatOriginForDisplay(origin)
  const { response } = await dialog.showMessageBox(window, {
    type: 'question',
    buttons: ['Allow', 'Block', 'Not now'],
    defaultId: NOT_NOW,
    cancelId: NOT_NOW,
    noLink: true,
    title: site,
    message: `${site} wants to show notifications`,
    detail: 'Notifications appear on your desktop, even while this tab is in the background. You can change this in Permissions.'
  })
  return ANSWERS[response] ?? 'dismiss'
}
