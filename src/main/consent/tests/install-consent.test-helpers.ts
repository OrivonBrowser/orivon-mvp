import type { InstallConsentPrompt } from '../install-consent.js'

/** A person who switches every row on (Grant all). */
export const grantAll: InstallConsentPrompt = async (_origin, _manifest, capabilities) => capabilities

/** A person who closes the question with every switch off. */
export const grantNone: InstallConsentPrompt = async () => []

/** A person who dismisses the question (Escape, a closed tab, a navigation). */
export const dismissed: InstallConsentPrompt = async () => null
