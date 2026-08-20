import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test } from 'node:test'
import { CredentialsStore } from '../credentials.js'
import { AuthRequiredError } from '../errors.js'
import { TokenManager } from '../tokens.js'

const BASE_URL = 'https://vocuno.test'

function tempStore(): CredentialsStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vocuno-cli-test-'))
  return new CredentialsStore(path.join(dir, 'credentials.json'))
}

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>

/** Sequential fetch mock: each call consumes the next handler. */
function fetchQueue(handlers: Handler[]): { fetchFn: typeof fetch; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetchFn = (async (input: any, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    const handler = handlers.shift()
    if (!handler) throw new Error(`Unexpected fetch call to ${url}`)
    return handler(url, init)
  }) as typeof fetch
  return { fetchFn, calls }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const tokenResponse = (suffix: string) => ({
  access_token: `vmat_${suffix}`,
  token_type: 'Bearer',
  expires_in: 3600,
  refresh_token: `vmrt_${suffix}`,
  scope: 'mcp',
})

test('proactively refreshes an expired access token and rotates the refresh token', async () => {
  const store = tempStore()
  store.save({ clientId: 'vmc_c', accessToken: 'vmat_old', refreshToken: 'vmrt_old', expiresAt: Date.now() - 1000 })

  const { fetchFn, calls } = fetchQueue([
    (url, init) => {
      assert.equal(url, `${BASE_URL}/oauth/token`)
      const params = new URLSearchParams(String(init?.body))
      assert.equal(params.get('grant_type'), 'refresh_token')
      assert.equal(params.get('refresh_token'), 'vmrt_old')
      assert.equal(params.get('client_id'), 'vmc_c')
      return json(tokenResponse('new'))
    },
  ])

  const tokens = new TokenManager(store, BASE_URL, fetchFn)
  const accessToken = await tokens.getAccessToken()
  assert.equal(accessToken, 'vmat_new')
  assert.equal(calls.length, 1)

  // Rotation persisted: the NEW refresh token is on disk before anything uses
  // the new access token.
  const creds = store.load()
  assert.equal(creds?.refreshToken, 'vmrt_new')
  assert.equal(creds?.accessToken, 'vmat_new')
  assert.ok((creds?.expiresAt ?? 0) > Date.now())
})

test('rotated refresh token is persisted before the retried request goes out', async () => {
  const store = tempStore()
  store.save({ clientId: 'vmc_c', accessToken: 'vmat_stale', refreshToken: 'vmrt_old', expiresAt: Date.now() + 3600_000 })

  const { fetchFn } = fetchQueue([
    // 1: MCP request with the (stale-but-unexpired) token → 401
    (url, init) => {
      assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer vmat_stale')
      return json({ message: 'Unauthorized' }, 401)
    },
    // 2: token refresh
    () => json(tokenResponse('rotated')),
    // 3: retried MCP request — by now the rotated pair MUST be on disk
    (url, init) => {
      assert.equal(store.load()?.refreshToken, 'vmrt_rotated')
      assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer vmat_rotated')
      return json({ ok: true })
    },
  ])

  const tokens = new TokenManager(store, BASE_URL, fetchFn)
  const res = await tokens.authedFetch(`${BASE_URL}/mcp`, { headers: {} })
  assert.equal(res.status, 200)
})

test('rotation survives a failing follow-up request', async () => {
  const store = tempStore()
  store.save({ clientId: 'vmc_c', refreshToken: 'vmrt_old', accessToken: 'vmat_x', expiresAt: Date.now() - 1 })

  const { fetchFn } = fetchQueue([
    () => json(tokenResponse('kept')),
    () => json({ message: 'boom' }, 500),
  ])
  const tokens = new TokenManager(store, BASE_URL, fetchFn)
  const res = await tokens.authedFetch(`${BASE_URL}/mcp`)
  assert.equal(res.status, 500)
  // Even though the request failed, the rotated refresh token is persisted.
  assert.equal(store.load()?.refreshToken, 'vmrt_kept')
})

test('failed refresh clears the session and raises AuthRequiredError', async () => {
  const store = tempStore()
  store.save({ clientId: 'vmc_c', refreshToken: 'vmrt_dead', accessToken: 'vmat_x', expiresAt: Date.now() - 1 })

  const { fetchFn } = fetchQueue([
    () => json({ error: 'invalid_grant', error_description: 'Refresh token revoked' }, 400),
  ])
  const tokens = new TokenManager(store, BASE_URL, fetchFn)
  await assert.rejects(() => tokens.getAccessToken(), AuthRequiredError)

  const creds = store.load()
  assert.equal(creds?.refreshToken, undefined)
  assert.equal(creds?.accessToken, undefined)
  assert.equal(creds?.clientId, 'vmc_c') // client registration survives
})

test('no stored session raises AuthRequiredError without any network call', async () => {
  const store = tempStore()
  const { fetchFn, calls } = fetchQueue([])
  const tokens = new TokenManager(store, BASE_URL, fetchFn)
  await assert.rejects(() => tokens.getAccessToken(), AuthRequiredError)
  assert.equal(calls.length, 0)
})

test('second 401 after a successful refresh clears tokens and raises AuthRequiredError', async () => {
  const store = tempStore()
  store.save({ clientId: 'vmc_c', accessToken: 'vmat_a', refreshToken: 'vmrt_a', expiresAt: Date.now() + 3600_000 })

  const { fetchFn } = fetchQueue([
    () => json({ message: 'Unauthorized' }, 401),
    () => json(tokenResponse('b')),
    () => json({ message: 'Unauthorized' }, 401),
  ])
  const tokens = new TokenManager(store, BASE_URL, fetchFn)
  await assert.rejects(() => tokens.authedFetch(`${BASE_URL}/mcp`), AuthRequiredError)
  assert.equal(store.load()?.refreshToken, undefined)
})
