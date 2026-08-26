import { contextBridge } from 'electron'

// Placeholder surface. The real `orivon.*` capability API arrives at build
// step 2 and is specified in docs/architecture/capability-api.md -- the
// highest-care artefact in the repository, since the Electron shell is
// disposable and this interface is not.
//
// Nothing here may ever expose a raw MessagePort, an ipcRenderer handle, or
// any object carrying ambient authority. Closures only.
contextBridge.exposeInMainWorld('orivon', {
  version: 0
})
