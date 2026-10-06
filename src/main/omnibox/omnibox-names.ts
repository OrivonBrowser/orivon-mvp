// The names the dropdown and the address field are known by, apart from the modules that need them so a caller takes none of their imports.

/** The overlay that draws the rows (src/renderer/overlay/omnibox/). */
export const OMNIBOX_OVERLAY = 'omnibox'
/** The chrome module that drives the address field (src/renderer/chrome/address-suggest.ts). */
export const OMNIBOX_MODULE = 'address-suggest'
/** The chrome module that owns what the address field shows and when a page's address replaces it (src/renderer/chrome/navigation.ts). */
export const NAVIGATION_MODULE = 'navigation'
