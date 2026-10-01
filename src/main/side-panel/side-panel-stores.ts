// The panel's file store, one per process. The installer registers the real one; a process that never installed
// one (a unit test) and a private session use memory.
import type { ShellServices } from '../shell/shell-services.js'
import { MemorySidePanelStore } from './side-panel-store.js'
import type { SidePanelStore } from './side-panel-store.js'

const stores = new WeakMap<ShellServices, SidePanelStore>()

export function registerStore (services: ShellServices, store: SidePanelStore): void {
  stores.set(services, store)
}

/** The store for these services, made in memory the first time one is asked for and none was registered. */
export function storeFor (services: ShellServices): SidePanelStore {
  let store = stores.get(services)
  if (store === undefined) {
    store = new MemorySidePanelStore()
    stores.set(services, store)
  }
  return store
}
