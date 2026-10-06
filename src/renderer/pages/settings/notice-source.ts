// The privacy notice, bundled into the page so it reads with no network. The text is docs/privacy/notice.md,
// given as a module by scripts/privacy-notice-plugin.ts; the page draws it through notice-blocks.ts, never as markup.
import notice from 'virtual:privacy-notice'

export const NOTICE_TEXT: string = notice
