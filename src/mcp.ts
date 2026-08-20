import { HttpError } from './errors.js'
import { buildRequest, nextRequestId, parseMcpResponseBody } from './jsonrpc.js'
import type { TokenManager } from './tokens.js'
import { getCliVersion } from './version.js'

/** Latest Streamable-HTTP protocol revision; the server negotiates down. */
export const PROTOCOL_VERSION = '2025-06-18'

export interface ToolContentItem {
  type: string
  text?: string
  data?: string
  mimeType?: string
}

export interface ToolCallResult {
  content: ToolContentItem[]
  isError: boolean
}

export interface ToolDefinition {
  name: string
  title?: string
  description?: string
  inputSchema?: unknown
}

function httpErrorMessage(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body)
    const detail = parsed?.message ?? parsed?.error_description ?? parsed?.error
    if (detail) return `HTTP ${status}: ${Array.isArray(detail) ? detail.join('; ') : detail}`
  } catch {
    // not JSON
  }
  return `HTTP ${status} from MCP server`
}

/**
 * Minimal MCP Streamable-HTTP client. The server runs in stateless mode
 * (fresh server per POST, no sessions), so `initialize` here only negotiates
 * the protocol version once per process.
 */
export class McpClient {
  private negotiatedVersion: string | null = null

  constructor(
    private readonly tokens: TokenManager,
    private readonly mcpUrl: string,
  ) {}

  private async post(method: string, params?: unknown) {
    const id = nextRequestId()
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    }
    if (this.negotiatedVersion) headers['MCP-Protocol-Version'] = this.negotiatedVersion

    const res = await this.tokens.authedFetch(this.mcpUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(buildRequest(method, params, id)),
    })
    const contentType = res.headers.get('content-type') || ''
    const body = await res.text()
    const parseable = contentType.includes('application/json') || contentType.includes('text/event-stream')
    if (!parseable) throw new HttpError(res.status, httpErrorMessage(res.status, body))
    try {
      return parseMcpResponseBody(contentType, body, id)
    } catch (err) {
      if (!res.ok) throw new HttpError(res.status, httpErrorMessage(res.status, body))
      throw err
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (this.negotiatedVersion) return
    const response = await this.post('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'vocuno-cli', version: getCliVersion() },
    })
    if (response.error) throw new Error(`initialize failed: ${response.error.message}`)
    this.negotiatedVersion = response.result?.protocolVersion || PROTOCOL_VERSION
  }

  async request(method: string, params?: unknown): Promise<any> {
    await this.ensureInitialized()
    let response = await this.post(method, params)
    if (response.error?.code === -32002) {
      // "Server not initialized" — re-negotiate and retry once.
      this.negotiatedVersion = null
      await this.ensureInitialized()
      response = await this.post(method, params)
    }
    if (response.error) throw new Error(response.error.message)
    return response.result
  }

  async listTools(): Promise<ToolDefinition[]> {
    const result = await this.request('tools/list', {})
    return result?.tools ?? []
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolCallResult> {
    const result = await this.request('tools/call', { name, arguments: args })
    return { content: result?.content ?? [], isError: Boolean(result?.isError) }
  }
}

/**
 * First text payload of a tool result, JSON-parsed. Every Vocuno tool returns
 * its data as a single JSON text item (plus an optional cover image).
 */
export function primaryPayload(result: ToolCallResult): any {
  const text = result.content.find((item) => item.type === 'text' && typeof item.text === 'string')
  if (!text) return null
  try {
    return JSON.parse(text.text!)
  } catch {
    return text.text
  }
}

/**
 * Machine-friendly view of a tool result: text items parsed as JSON when
 * possible, image data replaced by a small stub (no base64 walls on stdout).
 */
export function presentToolResult(result: ToolCallResult): any {
  const items = result.content.map((item) => {
    if (item.type === 'text' && typeof item.text === 'string') {
      try {
        return JSON.parse(item.text)
      } catch {
        return item.text
      }
    }
    if (item.type === 'image') {
      return {
        type: 'image',
        mimeType: item.mimeType,
        bytes: item.data ? Math.floor((item.data.length * 3) / 4) : 0,
        note: 'binary data omitted',
      }
    }
    return item
  })
  return items.length === 1 ? items[0] : items
}
