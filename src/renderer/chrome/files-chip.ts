import { warningIcon } from '../pages/shared/icons.js'
import type { ChromeModule } from './context.js'

export const FILES_FAILED_LABEL = 'Some files of this page did not load, so it may look broken. Press to reload and try again.'

/** The mark in the address bar for a page that asked the verifier for files it could not give (a stylesheet, a script): a page that finished loading is not always a whole one. Pressing it reloads the page. */
export function createFilesChip (): ChromeModule {
  let chip: HTMLButtonElement | undefined

  return {
    name: 'files-chip',
    init: (ctx) => {
      chip = ctx.toolbarButton({
        id: 'files-chip',
        slot: 'address',
        order: 11,
        label: FILES_FAILED_LABEL,
        icon: () => warningIcon(),
        onClick: () => {
          const id = ctx.activeTab()?.id
          if (id !== undefined) ctx.shell.reload(id)
        }
      })
      chip.hidden = true
    },
    render: (state) => {
      if (chip !== undefined) chip.hidden = state.filesFailed < 1
    }
  }
}
