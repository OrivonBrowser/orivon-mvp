// The single import site for the Orivon capability surface. Consumers import
// from here, never from a sibling directly, so the internal file split can
// change without touching any stream.
//
// This directory references NO module other than its own siblings, and emits
// almost no runtime code -- ./limits.js is the sole exception, a frozen object
// literal. See scripts/check-contracts-pure.mjs and
// docs/planning/repo-and-parallel-work-design.md Part B.
//
// The two specifications this transcribes are the highest-care artefacts in
// the repository (ADR-0002): docs/architecture/capability-api.md and
// docs/architecture/handle-contracts.md. The Electron shell beneath this
// surface is disposable; this interface is not.

export type { OrivonErrorCode, OrivonError } from './errors.js'

export type {
  Handle,
  TcpSocket,
  TcpServer,
  UdpSocket,
  Datagram,
  FileHandle,
  FileStat,
  IdentityHandle
} from './handles.js'
