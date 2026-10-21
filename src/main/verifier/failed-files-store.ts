// The one record of the files each tab could not load; every window's tabs read the same, as `site-popups.ts` has one for pop-ups.
import type { WebContents } from 'electron'
import { FailedFiles } from './failed-files.js'

export const failedFiles = new FailedFiles<WebContents>()
