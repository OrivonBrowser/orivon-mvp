// What the verifier sets on Chromium's network service, registered to be sent again when the service restarts (the
// design note in ../sessions/README.md). Tied to Electron: the sessions the check goes on.
import type { Subsystem } from '../registry.js'
import { reapplyAfterNetworkServiceRestart } from '../sessions/network-service-runner.js'
import { noteCertificateChecks } from '../sessions/network-service-test-seam.js'
import { idleHost, installCertificateCheck } from './verifier-subsystem.js'

export const verifierNetworkServiceSubsystem: Subsystem = {
  name: 'verifier-network-service',
  afterReady: () => {
    // The new service starts without the check, and refuses every verifier host until it is set again.
    reapplyAfterNetworkServiceRestart('certificate check', (sessions) => {
      for (const target of sessions) installCertificateCheck(target)
      noteCertificateChecks(sessions.length)
      return `${String(sessions.length)} ${sessions.length === 1 ? 'session' : 'sessions'}`
    })
    // The host's own `net` context ended with the service and is not rebuilt: its next gateway, RPC and DNS-over-HTTPS fetches
    // stall for seconds or fail until the process is replaced. Asleep, its next request starts one.
    reapplyAfterNetworkServiceRestart('verifier host', () => {
      idleHost()
      return 'put to sleep'
    })
  }
}
