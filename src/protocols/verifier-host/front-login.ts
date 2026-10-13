// What the verifier host answers when a proxy asks it to sign in: the tunnel's front main handed it (`HostConfig.front`),
// for that front's own address and port alone, and nothing else. Any other challenge is cancelled, as a request with no
// listener would, so a proxy that is not the tunnel's never learns the secret.
import type { AnswerChallenge } from '../../loader/electron/request-fetch.js'
import type { HostConfig } from './protocol.js'

export function answerForFront (front: NonNullable<HostConfig['front']>): AnswerChallenge {
  return (info, callback) => {
    if (info.isProxy && info.host === '127.0.0.1' && info.port === front.port) callback(front.username, front.password)
    else callback()
  }
}
