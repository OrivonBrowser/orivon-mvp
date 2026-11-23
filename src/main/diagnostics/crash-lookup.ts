// How the cards and bars that offer a report find the crash record they are about, without importing the
// service: diagnostics-runner.ts fills these once at start. Before that, and in a unit test, nothing is found.

let pageCrash: (webContentsId: number) => string | undefined = () => undefined
const endedOnPurpose = new Set<number>()
let lastRun: () => string | undefined = () => undefined
let lastRunWhy: () => string | undefined = () => undefined

export function setCrashLookups (lookups: { readonly page: typeof pageCrash, readonly lastRun: typeof lastRun, readonly lastRunReason?: typeof lastRunWhy }): void {
  pageCrash = lookups.page
  lastRun = lookups.lastRun
  lastRunWhy = lookups.lastRunReason ?? (() => undefined)
}

/** The id of the newest record of a page that died in this run. */
export function crashIdOfPage (webContentsId: number): string | undefined {
  return pageCrash(webContentsId)
}

/** The id of the previous run's crash that has not been reported: a fatal error or an unclean exit. */
export function lastRunCrashId (): string | undefined {
  return lastRun()
}

/** The reason of that crash, which the bar words its offer by: `display-lost` is the desktop's doing, not a crash of Orivon's. */
export function lastRunCrashReason (): string | undefined {
  return lastRunWhy()
}

/** Where a report about a crash opens. */
export function reportPath (crashId: string | undefined): string {
  return crashId === undefined ? '/' : `/crash/${crashId}`
}

/** A page's renderer that Orivon is about to end because the person asked (the task manager): its death is not a crash to record. */
export function markEndedOnPurpose (webContentsId: number): void {
  endedOnPurpose.add(webContentsId)
}

/** Whether that page's death was marked, and forgets the mark. */
export function takeEndedOnPurpose (webContentsId: number): boolean {
  return endedOnPurpose.delete(webContentsId)
}
