import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

export interface Credentials {
  baseUrl?: string
  /** From one-time Dynamic Client Registration. */
  clientId?: string
  /** Loopback redirect URIs registered with the client (fixed random ports). */
  redirectUris?: string[]
  tokenEndpoint?: string
  userinfoEndpoint?: string
  accessToken?: string
  /** Rotates on every refresh — always persist the new one before using it. */
  refreshToken?: string
  /** Access-token expiry, ms since epoch. */
  expiresAt?: number
  scope?: string
  email?: string
  uid?: string
}

/**
 * Reads/writes the credentials file. Writes are atomic (temp file + rename in
 * the same directory) and the file is kept at mode 0600, the directory 0700.
 */
export class CredentialsStore {
  constructor(readonly filePath: string) {}

  load(): Credentials | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
      return parsed && typeof parsed === 'object' ? (parsed as Credentials) : null
    } catch {
      return null
    }
  }

  save(creds: Credentials): void {
    const dir = path.dirname(this.filePath)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const tmp = path.join(dir, `.credentials.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`)
    fs.writeFileSync(tmp, JSON.stringify(creds, null, 2) + '\n', { mode: 0o600 })
    fs.renameSync(tmp, this.filePath)
    try {
      fs.chmodSync(this.filePath, 0o600)
    } catch {
      // best-effort (no-op on Windows)
    }
  }

  update(patch: Partial<Credentials>): Credentials {
    const next = { ...(this.load() ?? {}), ...patch }
    this.save(next)
    return next
  }

  /** Sign out: drop tokens and identity but keep the registered OAuth client. */
  clearTokens(): void {
    const creds = this.load()
    if (!creds) return
    delete creds.accessToken
    delete creds.refreshToken
    delete creds.expiresAt
    delete creds.scope
    delete creds.email
    delete creds.uid
    this.save(creds)
  }
}
