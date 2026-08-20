import * as os from 'node:os'
import * as path from 'node:path'

export const DEFAULT_BASE_URL = 'https://vocuno.com'

/** Server origin. Override with VOCUNO_BASE_URL (e.g. the staging stack). */
export function getBaseUrl(): string {
  return (process.env.VOCUNO_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '')
}

export function getMcpUrl(baseUrl: string = getBaseUrl()): string {
  return `${baseUrl}/mcp`
}

/**
 * Token store location: ~/.config/vocuno/credentials.json (honors
 * XDG_CONFIG_HOME). Override with VOCUNO_CREDENTIALS_PATH — used by tests.
 */
export function getCredentialsPath(): string {
  if (process.env.VOCUNO_CREDENTIALS_PATH) return process.env.VOCUNO_CREDENTIALS_PATH
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return path.join(configHome, 'vocuno', 'credentials.json')
}
