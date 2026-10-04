import { ipcRenderer } from 'electron'

const formatIpcName = (name: string) => `crx-${name}`

// Registrations by event name, then by the key the page gave each one. A callback crossing
// the context bridge arrives as a fresh proxy every call, so identity can only be matched
// through a key the page holds (a string survives the crossing); without one the callback
// itself is the key, which is right when no bridge is involved.
const registrations = new Map<string, Map<unknown, (...args: any[]) => void>>()

export const addExtensionListener = (
  extensionId: string,
  name: string,
  callback: Function,
  key: unknown = callback,
) => {
  let byKey = registrations.get(name)
  if (byKey?.has(key)) return

  if (!byKey) {
    byKey = new Map()
    registrations.set(name, byKey)
    // TODO: should these IPCs be batched in a microtask?
    ipcRenderer.send('crx-add-listener', extensionId, name)
  }

  const wrapper = function (_event: unknown, ...args: any[]) {
    if (process.env.NODE_ENV === 'development') {
      console.log(name, '(result)', ...args)
    }
    callback(...args)
  }
  byKey.set(key, wrapper)
  ipcRenderer.addListener(formatIpcName(name), wrapper)
}

export const removeExtensionListener = (
  extensionId: string,
  name: string,
  callback: any,
  key: unknown = callback,
) => {
  const byKey = registrations.get(name)
  const wrapper = byKey?.get(key)
  if (!byKey || !wrapper) return

  ipcRenderer.removeListener(formatIpcName(name), wrapper)
  byKey.delete(key)

  if (byKey.size === 0) {
    registrations.delete(name)
    ipcRenderer.send('crx-remove-listener', extensionId, name)
  }
}
