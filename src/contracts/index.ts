// The single import site for the Orivon capability surface. Consumers import
// from here, never from a sibling directly, so the internal file split can
// change without touching any stream.
//
// This directory references only its own siblings -- no electron, no node:*,
// no package -- and emits almost no runtime code; ./limits.js and
// ./ipc.js hold the only two runtime values. See
// scripts/check-contracts-pure.mjs and
// docs/planning/repo-and-parallel-work-design.md Part B.
//
// The two specifications this transcribes are the highest-care artefacts in
// the repository (ADR-0002): docs/architecture/capability-api.md and
// docs/architecture/handle-contracts.md. The Electron shell beneath this
// surface is disposable; this interface is not.
//
// Reading order for someone new: errors -> handles -> manifest ->
// capability-api. That is the whole product surface in four files.

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

export type {
  Manifest,
  Capabilities,
  NetCapability,
  TcpCapability,
  UdpCapability,
  FsCapability,
  IdCapability,
  Grant,
  GrantId,
  CapabilityKind,
  Pattern
} from './manifest.js'

export type {
  Orivon,
  OrivonApp,
  OrivonNet,
  OrivonFs,
  OrivonId,
  CapabilityRequest
} from './capability-api.js'

export type { Limits } from './limits.js'
export { LIMITS } from './limits.js'

export type {
  RequestEnvelope,
  ResponseEnvelope,
  DataMessage,
  CreditMessage,
  StreamEndMessage,
  WriteMessage,
  WriteAckMessage,
  WriteFailedMessage,
  WriteEndMessage,
  WriteAbortMessage,
  BrokerToRendererMessage,
  RendererToBrokerMessage,
  PortMessage
} from './ipc.js'
export { CREDIT_COALESCE_BYTES, WRITE_HEARTBEAT_MS, WRITE_SILENCE_TIMEOUT_MS } from './ipc.js'
