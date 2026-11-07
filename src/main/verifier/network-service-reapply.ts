// What the verifier sets on Chromium's network service, registered to be sent again when the service restarts (the
// design note in ../sessions/README.md). Tied to Electron: the sessions the check goes on.
import type { Subsystem } from '../registry.js'
import { reapplyAfterNetworkServiceRestart, reapplyToSessionsAfterNetworkServiceRestart } from '../sessions/network-service-runner.js'
import { noteCertificateCheck } from '../sessions/network-service-test-seam.js'
import { idleHost, installCertificateCheck } from './verifier-subsystem.js'

export const verifierNetworkServiceSubsystem: Subsystem = {
  name: 'verifier-network-service',
  afterReady: () => {
    // The new service starts without the check, and refuses every verifier host until it is set again.
    reapplyToSessionsAfterNetworkServiceRestart('certificate check', (target) => {
      installCertificateCheck(target)
      noteCertificateCheck()
    })
    // The host's own `net` context ended with the service and is not rebuilt: its next gateway, RPC and DNS-over-HTTPS fetches
    // stall for seconds or fail until the process is replaced. Asleep, its next request starts one, and the IPFS and Swarm
    // nodes stop with it (they start again at the next ask).
    reapplyAfterNetworkServiceRestart('verifier host', () => {
      idleHost()
      return 'put to sleep'
    })
  }
}
