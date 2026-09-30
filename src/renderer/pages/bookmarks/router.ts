// Which folder an address names. `orivon://bookmarks` is the bookmarks bar; `/folder/<id>` is any folder of it or of
// Other bookmarks. Pure, so a hand-typed address is judged in one place.
export const DEFAULT_FOLDER = 'bar'

const FOLDER_PATH = /^\/folder\/([A-Za-z0-9_-]{1,32})\/?$/

/** The folder `pathname` names, or null when it names none (the page then shows the bar). */
export function folderFromPath (pathname: string): string | null {
  return FOLDER_PATH.exec(pathname)?.[1] ?? null
}

export function pathForFolder (id: string): string {
  return id === DEFAULT_FOLDER ? '/' : `/folder/${id}`
}
