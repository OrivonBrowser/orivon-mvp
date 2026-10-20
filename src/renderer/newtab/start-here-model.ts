// What the "Start here" card says. Pure, so the shape check and the wording run under plain vitest; `main.ts` draws it.
import type { StartHereView, StepId } from '../../main/newtab/start-here-state.js'

export interface StepText {
  readonly title: string
  /** One line of explanation, or none. */
  readonly detail: string | null
  /** What the step's button says, and where it goes. */
  readonly action: string
  readonly target: string
}

const IMPORT_TARGET = 'orivon://import'

/** The card's three steps, worded from the view main sent. */
export function stepText (id: StepId, view: StartHereView): StepText {
  switch (id) {
    case 'app': return { title: 'Open an app', detail: null, action: `Open ${view.app.name}`, target: view.app.address }
    case 'eth': return { title: 'See the shield on a .eth name', detail: 'The shield in the address bar shows how the name was checked.', action: 'Open a .eth site', target: view.site }
    case 'import': return { title: 'Bring your bookmarks', detail: null, action: 'Import from another browser', target: IMPORT_TARGET }
  }
}

const STEP_IDS: readonly string[] = ['app', 'eth', 'import']
const isAddress = (value: unknown): value is string => typeof value === 'string' && /^ipfs:\/\/[^\s]+$/.test(value)

/** The card out of what main answered; anything that is not its shape is no card, so a page never fails over it. */
export function readStartHere (answer: unknown): StartHereView | null {
  if (typeof answer !== 'object' || answer === null) return null
  const { app, site, steps, uboOn } = answer as Record<string, unknown>
  const appRecord = typeof app === 'object' && app !== null ? app as Record<string, unknown> : {}
  if (typeof appRecord['name'] !== 'string' || appRecord['name'] === '' || !isAddress(appRecord['address']) || !isAddress(site) || !Array.isArray(steps)) return null
  const shown: Array<{ id: StepId, done: boolean }> = []
  for (const step of steps as unknown[]) {
    const record = typeof step === 'object' && step !== null ? step as Record<string, unknown> : {}
    if (typeof record['id'] !== 'string' || !STEP_IDS.includes(record['id'])) return null
    shown.push({ id: record['id'] as StepId, done: record['done'] === true })
  }
  if (shown.length === 0) return null
  return { app: { name: appRecord['name'], address: appRecord['address'] }, site, steps: shown, uboOn: uboOn === true }
}
