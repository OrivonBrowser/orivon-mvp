// Binds `askQuestion` to this process's windows once the shell's services exist.
import type { ShellInstaller } from '../shell-installers.js'
import { bindAskQuestion, createAskQuestion } from './ask-question.js'

export const installQuestions: ShellInstaller = {
  name: 'questions',
  install: (_app, services) => {
    bindAskQuestion(createAskQuestion({ windows: services.windows, kiosk: services.kiosk }))
  }
}
