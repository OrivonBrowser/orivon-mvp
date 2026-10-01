// What the warning sheet says and how it reads what main sends. Pure, so it is unit-tested without a DOM.
import type { HttpsWarningView } from '../../../main/privacy/https-warning-overlay.js'

export const TITLE = 'This site does not support a secure connection'
export const BODY = 'Anything you send to or read from this site could be seen or changed by others on the network. You turned on Always use secure connections, so Orivon did not open it.'
export const CONTINUE_LABEL = 'Continue to the HTTP site'

export function isView (value: unknown): value is HttpsWarningView {
  if (typeof value !== 'object' || value === null) return false
  const { host, canGoBack } = value as Record<string, unknown>
  return typeof host === 'string' && host !== '' && typeof canGoBack === 'boolean'
}

/** With no page to go back to, the safe button closes the tab and says so. */
export const backLabel = (canGoBack: boolean): string => canGoBack ? 'Go back' : 'Close tab'
