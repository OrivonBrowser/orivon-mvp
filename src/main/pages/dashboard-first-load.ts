// The tabs Orivon opened on the new-tab page whose first document has not committed yet. Chromium can hand the
// browser that document's first requests before it records the commit, so the frame's URL still reads empty and the
// shell-scheme gate (route.ts) would refuse the page its own script: a new tab left without its dashboard, measured
// on macOS with many tabs opened at once. A tab leaves the set at its first main-frame commit, or as soon as a
// navigation to any other address starts, so a website's document is never in it.
import type { WebContents } from 'electron'

type Watched = Pick<WebContents, 'id' | 'on' | 'off' | 'once'>

const pending = new Set<number>()

const bare = (url: string): string => url.split(/[?#]/)[0] ?? url

/** Marks `contents`, made to show `dashboardUrl` and not yet loaded, until its first document commits. */
export function markFirstDashboardLoad (contents: Watched, dashboardUrl: string): void {
  const { id } = contents
  pending.add(id)
  const elsewhere = (details: { isMainFrame: boolean, url: string }): void => { if (details.isMainFrame && bare(details.url) !== bare(dashboardUrl)) settle() }
  const settle = (): void => {
    pending.delete(id)
    contents.off('did-navigate', settle)
    contents.off('did-start-navigation', elsewhere as never)
  }
  contents.on('did-navigate', settle)
  contents.on('did-start-navigation', elsewhere as never)
  contents.once('destroyed', settle)
}

/** Whether the web contents with this id is a new-tab page whose first document has not committed yet. */
export function isFirstDashboardLoad (webContentsId: number): boolean {
  return pending.has(webContentsId)
}
