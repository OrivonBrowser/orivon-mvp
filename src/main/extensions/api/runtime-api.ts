// `chrome.runtime.onInstalled`: answers the worker's one question at start-up,
// "was I just installed or updated" (../runtime-installed.ts holds the answer).
import { takePendingInstalled } from '../runtime-installed.js'
import type { ExtensionApiModule } from './api-types.js'

export const runtimeApi: ExtensionApiModule = {
  name: 'runtime',
  install: (ctx) => {
    ctx.handle('runtime.takeInstalled', ({ extension }) => takePendingInstalled(extension.id) ?? null)
  }
}
