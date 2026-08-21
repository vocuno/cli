import { getBaseUrl, getCredentialsPath, getMcpUrl } from './config.js'
import { CredentialsStore } from './credentials.js'
import { createCliFetch } from './http.js'
import { McpClient } from './mcp.js'
import { TokenManager } from './tokens.js'

export interface CliContext {
  baseUrl: string
  store: CredentialsStore
  tokens: TokenManager
  client: McpClient
  /** fetch with the CLI User-Agent attached — use for every call to Vocuno. */
  fetchFn: typeof fetch
}

export function createContext(): CliContext {
  const baseUrl = getBaseUrl()
  const store = new CredentialsStore(getCredentialsPath())
  const fetchFn = createCliFetch()
  const tokens = new TokenManager(store, baseUrl, fetchFn)
  const client = new McpClient(tokens, getMcpUrl(baseUrl))
  return { baseUrl, store, tokens, client, fetchFn }
}
