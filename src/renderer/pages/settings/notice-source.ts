// The privacy notice, bundled into the page so it reads with no network. The file is the one in
// docs/privacy/; the page draws it through notice-blocks.ts and never as markup.
import notice from '../../../../docs/privacy/notice.md?raw'

export const NOTICE_TEXT: string = notice
