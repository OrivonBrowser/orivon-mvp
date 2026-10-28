// Where Orivon's releases are published, and the page of one of them. The address is built from these constants and a
// tag that looks like a version: nothing in it is taken from a network answer, so "Open release page" can only ever
// open the one host.
export const GITHUB_OWNER = 'OrivonBrowser'
export const GITHUB_REPO = 'orivon-mvp'

export const RELEASES_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases`

const VERSION_TAG = /^v?\d+\.\d+\.\d+/

/** The page of the release tagged `tag`, or the list of releases when the tag does not look like a version. */
export function releaseUrl (tag: string | null): string {
  if (tag === null || !VERSION_TAG.test(tag)) return RELEASES_URL
  return `${RELEASES_URL}/tag/${encodeURIComponent(tag)}`
}

/** The name that follows the newest release the Orivon node keeps; what it opens is a start page that downloads the package for the visitor's system (`docs/development/packaging.md` section On IPFS). */
export const LATEST_RELEASE_NAME = 'latest.orivonstack.eth'

/** Where a tab opens that name, the address the address bar makes of it. Fixed, so no network answer can name another page. */
export const LATEST_RELEASE_URL = `https://${LATEST_RELEASE_NAME}/`
