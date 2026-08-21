import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildUserAgent, createCliFetch } from '../http.js'

test('buildUserAgent identifies the CLI, its version and the runtime', () => {
  const ua = buildUserAgent('1.2.3')
  assert.match(ua, /^vocuno-cli\/1\.2\.3 \(\w+; node\/\d+\.\d+\.\d+\)$/)
})

test('createCliFetch adds the User-Agent and keeps caller headers', async () => {
  let seen: Headers | undefined
  const fake = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    seen = new Headers(init?.headers)
    return new Response('ok')
  }) as typeof fetch
  const fetchFn = createCliFetch(fake, 'vocuno-cli/9.9.9 (test)')
  await fetchFn('https://example.test', { headers: { Authorization: 'Bearer x' } })
  assert.equal(seen?.get('user-agent'), 'vocuno-cli/9.9.9 (test)')
  assert.equal(seen?.get('authorization'), 'Bearer x')
})

test('createCliFetch does not override an explicit User-Agent', async () => {
  let seen: Headers | undefined
  const fake = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    seen = new Headers(init?.headers)
    return new Response('ok')
  }) as typeof fetch
  await createCliFetch(fake, 'vocuno-cli/1.0.0')('https://example.test', { headers: { 'User-Agent': 'custom' } })
  assert.equal(seen?.get('user-agent'), 'custom')
})
