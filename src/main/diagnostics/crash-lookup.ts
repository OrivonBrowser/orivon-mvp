// How the cards and bars that offer a report find the crash record they are about, without importing the
// service: diagnostics-runner.ts fills these once at start. Before that, and in a unit test, nothing is found.

let pageCrash: (webContentsId: number) => string | undefined = () => undefined
let lastRun: () => string | undefined = () => undefined

export function setCrashLookups (lookups: { readonly page: typeof pageCrash, readonly lastRun: typeof lastRun }): void {
  pageCrash = lookups.page
  lastRun = lookups.lastRun
}

/** The id of the newest record of a page that died in this run. */
export function crashIdOfPage (webContentsId: number): string | undefined {
  return pageCrash(webContentsId)
}

/** The id of the previous run's crash that has not been reported: a fatal error or an unclean exit. */
export function lastRunCrashId (): string | undefined {
  return lastRun()
}

/** Where a report about a crash opens. */
export function reportPath (crashId: string | undefined): string {
  return crashId === undefined ? '/' : `/crash/${crashId}`
}
