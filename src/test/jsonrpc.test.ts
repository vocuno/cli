import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildRequest, findResponse, parseMcpResponseBody, parseSseBody } from '../jsonrpc.js'

test('buildRequest frames a JSON-RPC 2.0 request', () => {
  assert.deepEqual(buildRequest('tools/list', {}, 7), {
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/list',
    params: {},
  })
  assert.deepEqual(buildRequest('ping', undefined, 8), { jsonrpc: '2.0', id: 8, method: 'ping' })
})

test('parses a plain-JSON response body', () => {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 3, result: { ok: true } })
  const response = parseMcpResponseBody('application/json; charset=utf-8', body, 3)
  assert.deepEqual(response.result, { ok: true })
})

test('parses an SSE-framed response body and picks the matching id', () => {
  const body = [
    'event: message',
    'data: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info"}}',
    '',
    'event: message',
    'data: {"jsonrpc":"2.0","id":5,"result":{"tools":[{"name":"generate_song"}]}}',
    '',
    '',
  ].join('\n')
  const response = parseMcpResponseBody('text/event-stream', body, 5)
  assert.deepEqual(response.result, { tools: [{ name: 'generate_song' }] })
})

test('joins multi-line SSE data fields with newlines', () => {
  const body = 'data: {"jsonrpc":"2.0",\ndata: "id":1,"result":{"a":1}}\n\n'
  const messages = parseSseBody(body)
  assert.deepEqual(messages, [{ jsonrpc: '2.0', id: 1, result: { a: 1 } }])
})

test('handles CRLF SSE framing', () => {
  const body = 'event: message\r\ndata: {"jsonrpc":"2.0","id":2,"result":{"crlf":true}}\r\n\r\n'
  const response = parseMcpResponseBody('text/event-stream', body, 2)
  assert.deepEqual(response.result, { crlf: true })
})

test('surfaces an id-null server error when no id matches', () => {
  const messages = [{ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }]
  const response = findResponse(messages, 9)
  assert.equal(response?.error?.code, -32700)
})

test('throws when the reply contains no response at all', () => {
  assert.throws(
    () => parseMcpResponseBody('text/event-stream', 'data: {"jsonrpc":"2.0","method":"x"}\n\n', 4),
    /No JSON-RPC response/,
  )
})
