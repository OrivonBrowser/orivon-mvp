// A bound on how often one cookie is written into one session: a store that changes what it is given would otherwise be written to for ever. Pure.

const WRITES_PER_WINDOW = 30
const WINDOW_MS = 5000
const BUDGETS_KEPT = 5000

export interface WriteBudget {
  /** Whether one more write of the cookie `identity` into the session `label` is within its budget; the write is counted. */
  readonly allows: (label: string, identity: string) => boolean
  /** How many writes were held back so far. */
  readonly suppressed: () => number
}

export function createWriteBudget (now: () => number, log: (line: string) => void): WriteBudget {
  const budgets = new Map<string, { since: number, count: number }>()
  let held = 0
  return {
    allows: (label, identity) => {
      const key = `${label}\u0000${identity}`
      const at = now()
      if (budgets.size > BUDGETS_KEPT) for (const [stale, budget] of budgets) if (at - budget.since > WINDOW_MS) budgets.delete(stale)
      const budget = budgets.get(key)
      if (budget === undefined || at - budget.since > WINDOW_MS) { budgets.set(key, { since: at, count: 1 }); return true }
      budget.count += 1
      if (budget.count <= WRITES_PER_WINDOW) return true
      held += 1
      if (budget.count === WRITES_PER_WINDOW + 1) log(`[cookie-mirror] a cookie keeps changing between sessions; it is not carried to ${label} for a while`)
      return false
    },
    suppressed: () => held
  }
}
