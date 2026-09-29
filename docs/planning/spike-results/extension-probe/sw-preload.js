const { contextBridge } = require('electron')
contextBridge.exposeInMainWorld('orivonSW', { ping: () => 'pong' })
