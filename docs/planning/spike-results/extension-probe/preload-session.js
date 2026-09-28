const { contextBridge } = require('electron')
let calls = 0
contextBridge.exposeInMainWorld('orivon', { whoami: () => { calls++; return { href: location.href, calls } }, version: '0' })
