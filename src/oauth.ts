import * as crypto from 'node:crypto'
import * as http from 'node:http'
import { openBrowser } from './browser.js'
import type { Credentials, CredentialsStore } from './credentials.js'
import { codeChallengeS256, generateCodeVerifier, generateState } from './pkce.js'
import type { TokenEndpointResponse } from './tokens.js'

export interface AuthServerMetadata {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  registration_endpoint: string
  userinfo_endpoint?: string
}

/** mcp is mandatory; openid+email let us show who is signed in. */
const OAUTH_SCOPE = 'mcp openid email'
/**
 * The server only accepts redirect URIs registered at DCR time, so we
 * register a batch of fixed random loopback ports once (the server caps a
 * client at 10) and bind whichever is free at login time.
 */
const REDIRECT_PORT_COUNT = 10
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000

export async function discoverMetadata(baseUrl: string, fetchFn: typeof fetch = fetch): Promise<AuthServerMetadata> {
  const res = await fetchFn(`${baseUrl}/.well-known/oauth-authorization-server`)
  if (!res.ok) throw new Error(`OAuth discovery failed (HTTP ${res.status})`)
  const metadata = (await res.json()) as AuthServerMetadata
  if (!metadata.authorization_endpoint || !metadata.token_endpoint || !metadata.registration_endpoint) {
    throw new Error('OAuth metadata is missing required endpoints')
  }
  return metadata
}

function randomLoopbackRedirectUris(): string[] {
  const ports = new Set<number>()
  while (ports.size < REDIRECT_PORT_COUNT) ports.add(20000 + crypto.randomInt(40000))
  return [...ports].map((port) => `http://127.0.0.1:${port}/callback`)
}

/** One-time Dynamic Client Registration (RFC 7591); cached in the store. */
async function registerClient(
  store: CredentialsStore,
  metadata: AuthServerMetadata,
  fetchFn: typeof fetch,
): Promise<{ clientId: string; redirectUris: string[] }> {
  const redirectUris = randomLoopbackRedirectUris()
  const res = await fetchFn(metadata.registration_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Vocuno CLI',
      redirect_uris: redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: OAUTH_SCOPE,
    }),
  })
  if (!res.ok) throw new Error(`Client registration failed (HTTP ${res.status}): ${await res.text()}`)
  const body = (await res.json()) as { client_id: string; redirect_uris?: string[] }
  const registered = {
    clientId: body.client_id,
    redirectUris: Array.isArray(body.redirect_uris) && body.redirect_uris.length ? body.redirect_uris : redirectUris,
  }
  store.update({
    clientId: registered.clientId,
    redirectUris: registered.redirectUris,
    tokenEndpoint: metadata.token_endpoint,
    userinfoEndpoint: metadata.userinfo_endpoint,
  })
  return registered
}

/**
 * Cheap server-side check that our cached client_id still exists: a GET on
 * /oauth/authorize 302-redirects for a known client/redirect pair and 400s
 * for an unknown one (client records can be pruned server-side).
 */
async function clientIsValid(
  metadata: AuthServerMetadata,
  clientId: string,
  redirectUri: string,
  fetchFn: typeof fetch,
): Promise<boolean> {
  try {
    const url = new URL(metadata.authorization_endpoint)
    url.searchParams.set('client_id', clientId)
    url.searchParams.set('redirect_uri', redirectUri)
    const res = await fetchFn(url.toString(), { redirect: 'manual' })
    return res.status >= 300 && res.status < 400
  } catch {
    return false
  }
}

function listen(port: number): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = http.createServer()
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve(server)
    })
  })
}

async function listenOnRegisteredPort(
  redirectUris: string[],
): Promise<{ server: http.Server; redirectUri: string } | null> {
  for (const uri of redirectUris) {
    const port = Number(new URL(uri).port)
    if (!port) continue
    try {
      return { server: await listen(port), redirectUri: uri }
    } catch {
      // port busy — try the next registered one
    }
  }
  return null
}

function waitForCallback(server: http.Server, expectedState: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Timed out waiting for the browser sign-in (5 minutes). Run: vocuno auth login'))
    }, LOGIN_TIMEOUT_MS)
    timer.unref()

    server.on('request', (req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      if (url.pathname !== '/callback') {
        res.writeHead(404).end()
        return
      }
      const fail = (message: string) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(`<html><body style="font-family:sans-serif"><h2>Sign-in failed</h2><p>${message}</p></body></html>`)
        clearTimeout(timer)
        reject(new Error(message))
      }

      const error = url.searchParams.get('error')
      if (error) {
        fail(url.searchParams.get('error_description') || `Authorization failed: ${error}`)
        return
      }
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')
      if (!code) {
        fail('No authorization code in the callback')
        return
      }
      if (state !== expectedState) {
        fail('State mismatch in the OAuth callback — please retry the sign-in')
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(
        '<html><body style="font-family:sans-serif"><h2>Signed in to Vocuno CLI</h2>' +
          '<p>You can close this tab and return to the terminal.</p></body></html>',
      )
      clearTimeout(timer)
      resolve(code)
    })
  })
}

async function exchangeCode(
  tokenEndpoint: string,
  params: { code: string; clientId: string; redirectUri: string; codeVerifier: string },
  fetchFn: typeof fetch,
): Promise<TokenEndpointResponse> {
  const res = await fetchFn(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: params.code,
      client_id: params.clientId,
      redirect_uri: params.redirectUri,
      code_verifier: params.codeVerifier,
    }).toString(),
  })
  const body = await res.text()
  if (!res.ok) {
    let detail = body
    try {
      const parsed = JSON.parse(body)
      detail = parsed.error_description || parsed.error || body
    } catch {
      // keep raw body
    }
    throw new Error(`Token exchange failed: ${detail}`)
  }
  return JSON.parse(body) as TokenEndpointResponse
}

async function fetchIdentity(
  userinfoEndpoint: string | undefined,
  accessToken: string,
  fetchFn: typeof fetch,
): Promise<{ uid?: string; email?: string }> {
  if (!userinfoEndpoint) return {}
  try {
    const res = await fetchFn(userinfoEndpoint, { headers: { Authorization: `Bearer ${accessToken}` } })
    if (!res.ok) return {}
    const info = (await res.json()) as { sub?: string; email?: string }
    return { uid: info.sub, email: info.email }
  } catch {
    return {}
  }
}

export interface LoginOptions {
  baseUrl: string
  store: CredentialsStore
  fetchFn?: typeof fetch
  open?: boolean
  log?: (message: string) => void
}

/**
 * Full OAuth 2.1 authorization-code + PKCE login:
 * discovery → (cached) DCR → loopback server → browser consent → code
 * exchange → persist tokens → userinfo.
 */
export async function login(options: LoginOptions): Promise<Credentials> {
  const fetchFn = options.fetchFn ?? fetch
  const log = options.log ?? ((message: string) => console.error(message))
  const { store, baseUrl } = options

  const metadata = await discoverMetadata(baseUrl, fetchFn)
  store.update({ baseUrl, tokenEndpoint: metadata.token_endpoint, userinfoEndpoint: metadata.userinfo_endpoint })

  let creds = store.load()
  let clientId = creds?.clientId
  let redirectUris = creds?.redirectUris ?? []
  if (!clientId || redirectUris.length === 0 || !(await clientIsValid(metadata, clientId, redirectUris[0], fetchFn))) {
    log('Registering CLI with the Vocuno authorization server...')
    const registered = await registerClient(store, metadata, fetchFn)
    clientId = registered.clientId
    redirectUris = registered.redirectUris
  }

  let bound = await listenOnRegisteredPort(redirectUris)
  if (!bound) {
    // Every registered port is busy — register a fresh client on new ports.
    log('Registered callback ports are busy — registering fresh ones...')
    const registered = await registerClient(store, metadata, fetchFn)
    clientId = registered.clientId
    redirectUris = registered.redirectUris
    bound = await listenOnRegisteredPort(redirectUris)
    if (!bound) throw new Error('Could not bind a loopback port for the OAuth callback')
  }

  const { server, redirectUri } = bound
  try {
    const codeVerifier = generateCodeVerifier()
    const state = generateState()
    const authorizeUrl = new URL(metadata.authorization_endpoint)
    authorizeUrl.searchParams.set('response_type', 'code')
    authorizeUrl.searchParams.set('client_id', clientId)
    authorizeUrl.searchParams.set('redirect_uri', redirectUri)
    authorizeUrl.searchParams.set('code_challenge', codeChallengeS256(codeVerifier))
    authorizeUrl.searchParams.set('code_challenge_method', 'S256')
    authorizeUrl.searchParams.set('scope', OAUTH_SCOPE)
    authorizeUrl.searchParams.set('state', state)

    log(`Opening your browser to sign in:\n  ${authorizeUrl.toString()}\n`)
    if (options.open !== false) openBrowser(authorizeUrl.toString())
    log('Waiting for the browser sign-in to complete...')

    const code = await waitForCallback(server, state)
    const tokens = await exchangeCode(
      metadata.token_endpoint,
      { code, clientId, redirectUri, codeVerifier },
      fetchFn,
    )
    // Persist before doing anything else with the tokens.
    store.update({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + tokens.expires_in * 1000,
      scope: tokens.scope,
    })
    const identity = await fetchIdentity(metadata.userinfo_endpoint, tokens.access_token, fetchFn)
    if (identity.uid || identity.email) store.update(identity)
    return store.load()!
  } finally {
    server.close()
  }
}
