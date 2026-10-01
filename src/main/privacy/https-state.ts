// What HTTPS-only remembers while Orivon runs, and nothing longer: the hosts
// the person chose to open over plain HTTP, and for each tab the address whose
// upgrade failed. Pure: no `electron` import.

/** Hosts opened over plain HTTP on the person's say-so. Memory only, so the choice lasts until Orivon exits. */
export interface HttpsExemptions {
  add: (host: string) => void
  has: (host: string) => boolean
}

export function createHttpsExemptions (): HttpsExemptions {
  const hosts = new Set<string>()
  const key = (host: string): string => host.toLowerCase().replace(/\.$/, '')
  return { add: (host) => { hosts.add(key(host)) }, has: (host) => hosts.has(key(host)) }
}

/** The plain-HTTP address a tab's failed upgrade came from: what "continue" opens. It is kept here, never taken from the sheet. */
export interface FailedUpgrade {
  readonly from: string
  readonly host: string
}

export interface FailedUpgrades {
  set: (tabId: string, failed: FailedUpgrade) => void
  get: (tabId: string) => FailedUpgrade | undefined
  clear: (tabId: string) => void
}

export function createFailedUpgrades (): FailedUpgrades {
  const byTab = new Map<string, FailedUpgrade>()
  return {
    set: (tabId, failed) => { byTab.set(tabId, failed) },
    get: (tabId) => byTab.get(tabId),
    clear: (tabId) => { byTab.delete(tabId) }
  }
}

export interface HttpsState {
  readonly exemptions: HttpsExemptions
  readonly failed: FailedUpgrades
}

export function createHttpsState (): HttpsState {
  return { exemptions: createHttpsExemptions(), failed: createFailedUpgrades() }
}

/** The one state the running shell shares between the handlers, the fallback and the sheet. */
export const httpsState: HttpsState = createHttpsState()
