import { getBaseUrl, getCredentialsPath, getMcpUrl } from './config.js'
import { CredentialsStore } from './credentials.js'
import { McpClient } from './mcp.js'
import { TokenManager } from './tokens.js'

export interface CliContext {
  baseUrl: string
  store: CredentialsStore
  tokens: TokenManager
  client: McpClient
}

export function createContext(): CliContext {
  const baseUrl = getBaseUrl()
  const store = new CredentialsStore(getCredentialsPath())
  const tokens = new TokenManager(store, baseUrl)
  const client = new McpClient(tokens, getMcpUrl(baseUrl))
  return { baseUrl, store, tokens, client }
}
