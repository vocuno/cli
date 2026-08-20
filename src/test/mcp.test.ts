import assert from 'node:assert/strict'
import { test } from 'node:test'
import { presentToolResult, primaryPayload } from '../mcp.js'

test('primaryPayload parses the first text item as JSON', () => {
  const result = {
    isError: false,
    content: [
      { type: 'text', text: '{"task_id":"t1","status":"complete"}' },
      { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' },
    ],
  }
  assert.deepEqual(primaryPayload(result), { task_id: 't1', status: 'complete' })
})

test('primaryPayload returns raw text when not JSON', () => {
  assert.equal(primaryPayload({ isError: false, content: [{ type: 'text', text: 'plain' }] }), 'plain')
})

test('presentToolResult stubs image data instead of dumping base64', () => {
  const result = {
    isError: false,
    content: [
      { type: 'text', text: '{"ok":true}' },
      { type: 'image', data: 'A'.repeat(4000), mimeType: 'image/jpeg' },
    ],
  }
  const presented = presentToolResult(result)
  assert.deepEqual(presented[0], { ok: true })
  assert.equal(presented[1].type, 'image')
  assert.equal(presented[1].mimeType, 'image/jpeg')
  assert.equal(presented[1].bytes, 3000)
  assert.equal(presented[1].data, undefined)
})

test('presentToolResult unwraps a single text payload', () => {
  const presented = presentToolResult({ isError: false, content: [{ type: 'text', text: '{"credits_remaining":42}' }] })
  assert.deepEqual(presented, { credits_remaining: 42 })
})
