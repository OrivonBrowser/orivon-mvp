// Whether a request for a tab's page is the first of a navigation the person started, a navigation a page started, or a hop after
// the first (a redirect). Pure over what the request carries: no `electron` import.

/** The part of a main-frame request that tells how its navigation began. */
export interface MainFrameRequest {
  /** One for the whole navigation: a redirect keeps the id of the request it redirects. */
  readonly id: number
  readonly webContentsId?: number
  /** The origin of the page that issued the request; absent for a request the browser started itself, and kept across redirects. */
  readonly initiatorOrigin?: string
  readonly referrer: string
}

/** `browser`: the first request of a navigation the browser started (address bar, bookmark, history, a restored tab). `page`: the first request of one a page started. `redirect`: any later hop. */
export type Hop = 'browser' | 'page' | 'redirect'

export interface NavigationHops {
  readonly classify: (request: MainFrameRequest) => Hop
  /** A tab is gone. */
  readonly forget: (webContentsId: number) => void
}

export function createNavigationHops (): NavigationHops {
  /** The navigation each tab's last main-frame request belonged to. */
  const last = new Map<number, number>()
  return {
    classify: (request) => {
      if (request.webContentsId === undefined) return 'page'
      if (last.get(request.webContentsId) === request.id) return 'redirect'
      last.set(request.webContentsId, request.id)
      // A tab a page opens carries the page as its referrer, and a page's own navigation names its origin: only a load nobody else asked for has neither.
      return request.initiatorOrigin === undefined && request.referrer === '' ? 'browser' : 'page'
    },
    forget: (webContentsId) => { last.delete(webContentsId) }
  }
}
