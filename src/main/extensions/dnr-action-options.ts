// The argument of declarativeNetRequest.setExtensionActionOptions, checked the way Chrome checks it: an
// extension's own value is never trusted to have the shape the type says.
export interface ActionOptions {
  readonly displayActionCountAsBadgeText?: boolean
  readonly tabUpdate?: { readonly tabId: number, readonly increment: number }
}

const INVALID = 'Invalid argument: setExtensionActionOptions takes an object with displayActionCountAsBadgeText (a boolean) and tabUpdate ({ tabId, increment }, both integers).'

function fail (): never { throw new Error(INVALID) }

export function parseActionOptions (raw: unknown): ActionOptions {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return fail()
  const { displayActionCountAsBadgeText, tabUpdate } = raw as Record<string, unknown>
  if (displayActionCountAsBadgeText !== undefined && typeof displayActionCountAsBadgeText !== 'boolean') return fail()
  let update: ActionOptions['tabUpdate']
  if (tabUpdate !== undefined) {
    if (typeof tabUpdate !== 'object' || tabUpdate === null || Array.isArray(tabUpdate)) return fail()
    const { tabId, increment } = tabUpdate as Record<string, unknown>
    if (typeof tabId !== 'number' || !Number.isInteger(tabId) || tabId < 0) return fail()
    if (typeof increment !== 'number' || !Number.isSafeInteger(increment)) return fail()
    update = { tabId, increment }
  }
  return {
    ...(displayActionCountAsBadgeText === undefined ? {} : { displayActionCountAsBadgeText }),
    ...(update === undefined ? {} : { tabUpdate: update })
  }
}
