const { contextBridge } = require('electron')
contextBridge.exposeInMainWorld('orivonWp', { ping: () => 'pong' })
