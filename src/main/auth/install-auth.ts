// Wires the two questions a server can ask of a tab before it answers: a username and password (`login`) and a
// client certificate (`select-client-certificate`). Each is answered by a sheet over the tab that asked; anything
// that is not a tab keeps Electron's own answer, which is no.
import type { ShellInstaller } from '../shell/shell-installers.js'
import { askChooser } from './ask-chooser.js'
import { watchCertErrors } from './cert-error-watch.js'
import { challenges } from './auth-state.js'
import { handleSelectClientCertificate } from './client-certificate.js'
import { handleLogin } from './login-handler.js'
import { hostsOfTabs } from './certificate-open.js'
import { certificates } from './note-certificate.js'
import { loadOf } from './tab-load.js'
import { requestSlot } from '../overlays/tab-slots.js'
import { upgradeTracker } from '../privacy/https-fallback.js'
import { setPendingAddress } from '../shell/signals/pending-address.js'

const formatDate = (ms: number): string => new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })

export const installAuth: ShellInstaller = {
  name: 'auth',
  install: (app, services) => {
    const findTab = (contents: Parameters<typeof services.windows.findTab>[0]): ReturnType<typeof services.windows.findTab> => services.windows.findTab(contents)
    const login = { challenges, findTab, loadOf, ask: requestSlot, pending: setPendingAddress }
    const certificate = { findTab, ask: askChooser, formatDate, now: Date.now }
    app.on('login', (event, contents, details, info, callback) => { handleLogin(login, event, contents, details, info, callback) })
    app.on('select-client-certificate', (event, contents, url, list, callback) => { handleSelectClientCertificate(certificate, event, contents, url, list, callback) })
    certificates.keepHosts(() => hostsOfTabs(services.windows.all()))
    const certErrors = { findTab, ask: requestSlot, claimed: (id: number, url: string, code: number) => upgradeTracker.claims(id, url, code) }
    services.tabLifecycle.subscribe({
      tabCreated: (contents) => { watchCertErrors(contents, certErrors) },
      viewReplaced: (_old, contents) => { watchCertErrors(contents, certErrors) },
      tabClosing: ({ id, window }) => {
        const owner = services.windows.all().find((candidate) => candidate.window === window)
        if (owner !== undefined) challenges.dropTab(owner, id)
      }
    })
  }
}
