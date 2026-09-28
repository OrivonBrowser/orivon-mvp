import { EventEmitter } from 'node:events'
import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'
import { getExtensionManifest } from './common'

export class RuntimeAPI extends EventEmitter {
  constructor(private ctx: ExtensionContext) {
    super()

    const handle = this.ctx.router.apiHandler()
    handle('runtime.connectNative', this.connectNative, { permission: 'nativeMessaging' })
    handle('runtime.disconnectNative', this.disconnectNative, { permission: 'nativeMessaging' })
    handle('runtime.openOptionsPage', this.openOptionsPage)
    handle('runtime.sendNativeMessage', this.sendNativeMessage, { permission: 'nativeMessaging' })
  }

  // Orivon patch: native messaging spawns a host process, which the no-native-code rule
  // (CLAUDE.md rule 8) forbids outside the broker. The handlers stay registered so an
  // extension gets this error instead of silently hanging.
  private connectNative = async (
    _event: ExtensionEvent,
    _connectionId: string,
    _application: string,
  ) => {
    throw new Error('Native messaging is not supported in Orivon')
  }

  private disconnectNative = (_event: ExtensionEvent, _connectionId: string) => {
    throw new Error('Native messaging is not supported in Orivon')
  }

  private sendNativeMessage = async (
    _event: ExtensionEvent,
    _application: string,
    _message: any,
  ) => {
    throw new Error('Native messaging is not supported in Orivon')
  }

  private openOptionsPage = async ({ extension }: ExtensionEvent) => {
    // TODO: options page shouldn't appear in Tabs API
    // https://developer.chrome.com/extensions/options#tabs-api

    const manifest = getExtensionManifest(extension)

    if (manifest.options_ui) {
      // Embedded option not support (!options_ui.open_in_new_tab)
      const url = `chrome-extension://${extension.id}/${manifest.options_ui.page}`
      await this.ctx.store.createTab({ url, active: true })
    } else if (manifest.options_page) {
      const url = `chrome-extension://${extension.id}/${manifest.options_page}`
      await this.ctx.store.createTab({ url, active: true })
    }
  }
}
