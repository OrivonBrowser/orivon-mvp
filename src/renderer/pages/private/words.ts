// What the Private page says, as data: the same page for an ordinary private window and for one that goes through Nym only.
// Pure, so the words are tested without a DOM.

export type PrivateTunnel = 'nym' | undefined

export interface PrivateWords {
  readonly title: string
  readonly lead: string
  readonly keeps: readonly string[]
  readonly keepsNot: readonly string[]
  readonly hidesNot: readonly string[]
  readonly another: string
}

const KEEPS = [
  'Cookies, site data and the cache of the sites you visit.',
  'The permissions you give sites and apps. Each is asked for again, and none carries over from your profile.',
  'The files you pick for an app to use, and what an app stores here.',
  'Your bookmarks and zoom levels, if you make any: they are deleted with the window.',
  'Apps work here as anywhere, but start with no permissions and no files of their own.'
] as const

const KEEPS_NOT = [
  'A history of the pages you visit.',
  'Usage statistics: none are collected or sent.',
  'Your identity key. Apps that ask for it get a new one for this window, and cannot save secrets with it.'
] as const

const HIDES_NOT = [
  'Your network address: sites, and whoever runs your network, still see where you connect from.',
  'Files you download: they stay on your computer.',
  'Who you are to a site you sign in to.'
] as const

export function privateWords (tunnel: PrivateTunnel): PrivateWords {
  if (tunnel === 'nym') {
    return {
      title: 'You are in a private window with Nym',
      lead: 'Every page and everything Orivon sends for itself goes through Nym, and everything this window kept is deleted when you close its last window. The tunnel cannot be turned off here.',
      keeps: KEEPS,
      keepsNot: KEEPS_NOT,
      hidesNot: [
        'Your network address from Nym\'s gateways: they see this computer\'s address, and the sites you reach see only an exit address.',
        'Files you download: they stay on your computer.',
        'Who you are to a site you sign in to.'
      ],
      another: 'Open another private window with Nym'
    }
  }
  return {
    title: 'You are in a private window',
    lead: 'It starts empty, and everything it holds is deleted when you close its last window.',
    keeps: KEEPS,
    keepsNot: KEEPS_NOT,
    hidesNot: HIDES_NOT,
    another: 'Open another private window'
  }
}
