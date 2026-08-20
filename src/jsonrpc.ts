export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id?: number | string | null
  result?: any
  error?: JsonRpcError
}

let counter = 0

export function nextRequestId(): number {
  return ++counter
}

export function buildRequest(method: string, params: unknown, id: number) {
  return {
    jsonrpc: '2.0' as const,
    id,
    method,
    ...(params === undefined ? {} : { params }),
  }
}

/** Parse a text/event-stream body into its JSON `data:` payloads. */
export function parseSseBody(body: string): unknown[] {
  const messages: unknown[] = []
  const events = body.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n\n')
  for (const event of events) {
    const dataLines: string[] = []
    for (const line of event.split('\n')) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
    }
    if (dataLines.length === 0) continue
    try {
      messages.push(JSON.parse(dataLines.join('\n')))
    } catch {
      // non-JSON data frame (keep-alive etc) — ignore
    }
  }
  return messages
}

export function findResponse(messages: unknown[], id: number): JsonRpcResponse | null {
  const candidates: JsonRpcResponse[] = []
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue
    const m = message as JsonRpcResponse
    if (!('result' in m) && !('error' in m)) continue
    if (m.id === id) return m
    candidates.push(m)
  }
  // A parse-level server error comes back with id null — surface it rather
  // than pretending the server said nothing.
  const orphanError = candidates.find((m) => m.error && (m.id === null || m.id === undefined))
  return orphanError ?? null
}

/** Parse an MCP Streamable-HTTP POST response body (plain JSON or SSE-framed). */
export function parseMcpResponseBody(contentType: string, body: string, id: number): JsonRpcResponse {
  const isSse = contentType.includes('text/event-stream')
  const messages = isSse ? parseSseBody(body) : [JSON.parse(body)]
  const response = findResponse(messages, id)
  if (!response) throw new Error(`No JSON-RPC response with id ${id} in server reply`)
  return response
}
