// Whether F7 switches caret browsing straight on or off, or asks first, and which tabs carry it. Pure: the runner
// is ./caret-runner.ts.

export type CaretPlan = 'turn-off' | 'ask' | 'turn-on'

export const CARET_SETTING = 'accessibility.caretBrowsing'
export const CARET_ASK_SETTING = 'accessibility.caretAsk'
export const CARET_CONFIRM_OVERLAY = 'caret-confirm'

/** Turning it off never asks: it only takes away something a person did not want. */
export function caretPlan ({ on, ask }: { on: boolean, ask: boolean }): CaretPlan {
  if (on) return 'turn-off'
  return ask ? 'ask' : 'turn-on'
}

/** Every tab but the new-tab page, which is Orivon's own page of buttons and has no text to read. */
export const caretAppliesTo = (tab: { readonly isDashboardTab: boolean }): boolean => !tab.isDashboardTab
