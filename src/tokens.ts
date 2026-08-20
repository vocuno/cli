import type { CredentialsStore } from './credentials.js'
import { AuthRequiredError } from './errors.js'

export interface TokenEndpointResponse {
  access_token: string
  token_type: string
  expires_in: number
  refresh_token: string
  scope: string
}

/** Refresh this long before the stored expiry to avoid racing the clock. */
const EXPIRY_MARGIN_MS = 60_000

function withBearer(init: RequestInit, token: string): RequestInit {
  return {
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` },
  }
}

function oauthErrorMessage(body: string): string | null {
  try {
    const parsed = JSON.parse(body)
    if (parsed?.error_description) return String(parsed.error_description)
    if (parsed?.error) return String(parsed.error)
  } catch {
    // not JSON
  }
  return null
}

/**
 * Owns access-token lifecycle: proactive refresh near expiry, refresh-token
 * rotation (the NEW refresh token is persisted atomically before anything
 * uses the new access token), and a single refresh-and-retry on 401.
 */
export class TokenManager {
  constructor(
    private readonly store: CredentialsStore,
    private readonly baseUrl: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private tokenEndpoint(): string {
    return this.store.load()?.tokenEndpoint || `${this.baseUrl}/oauth/token`
  }

  async getAccessToken(): Promise<string> {
    const creds = this.store.load()
    if (!creds?.accessToken && !creds?.refreshToken) throw new AuthRequiredError()

    const fresh = Boolean(creds.accessToken && creds.expiresAt && Date.now() < creds.expiresAt - EXPIRY_MARGIN_MS)
    if (fresh) return creds.accessToken!
    if (!creds.refreshToken) {
      // No way to refresh — try the token we have and let a 401 decide.
      if (creds.accessToken) return creds.accessToken
      throw new AuthRequiredError()
    }
    return this.refresh()
  }

  /**
   * Refresh + rotate. Vocuno revokes the old refresh token the moment the new
   * one is issued, so the rotated pair is persisted before this returns.
   */
  async refresh(): Promise<string> {
    const creds = this.store.load()
    if (!creds?.refreshToken || !creds.clientId) throw new AuthRequiredError()

    const res = await this.fetchFn(this.tokenEndpoint(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: creds.refreshToken,
        client_id: creds.clientId,
      }).toString(),
    })
    const body = await res.text()
    if (!res.ok) {
      // invalid_grant (revoked/expired/rotated-away) — the session is over.
      this.store.clearTokens()
      throw new AuthRequiredError(oauthErrorMessage(body) ?? `Token refresh failed (HTTP ${res.status})`)
    }

    const tokens = JSON.parse(body) as TokenEndpointResponse
    this.store.update({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + tokens.expires_in * 1000,
      scope: tokens.scope,
    })
    return tokens.access_token
  }

  /** Bearer-authenticated fetch with a single refresh-and-retry on 401. */
  async authedFetch(url: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.getAccessToken()
    const res = await this.fetchFn(url, withBearer(init, token))
    if (res.status !== 401) return res

    const refreshed = await this.refresh() // throws AuthRequiredError when it can't
    const retry = await this.fetchFn(url, withBearer(init, refreshed))
    if (retry.status === 401) {
      this.store.clearTokens()
      throw new AuthRequiredError()
    }
    return retry
  }
}
