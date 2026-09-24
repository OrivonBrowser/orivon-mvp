// The servers the verifier asks by default, chosen by the ENS and IPFS spike
// (docs/planning/spike-results/ens-ipfs.md). Each is trusted for
// availability only: the light client proves what the RPC and the beacon
// API say, and every block and record from the rest is checked. Every launch
// contacts the RPCs and the beacon API while the light client runs.

export const DEFAULT_ENDPOINTS = {
  // Each answer is proven, so any of these may serve a request; the first is the fastest measured.
  executionRpcs: ['https://eth.drpc.org', 'https://rpc.mevblocker.io', 'https://ethereum-rpc.publicnode.com'],
  consensusRpc: 'https://ethereum-beacon-api.publicnode.com',
  gateways: ['https://trustless-gateway.link', 'https://ipfs.orbitor.dev', 'https://ipfs.filebase.io'],
  ipnsNameServices: ['https://name.web3.storage'],
  dnsOverHttps: ['https://cloudflare-dns.com/dns-query', 'https://dns.google/resolve']
} as const
