import { createHash, randomBytes } from 'node:crypto'

/**
 * PKCE (RFC 7636), S256 only — the sole method Vocuno's authorization server
 * accepts. base64url of 48 random bytes gives a 64-char verifier drawn from
 * the RFC's unreserved charset (43-128 chars required).
 */
export function generateCodeVerifier(): string {
  return randomBytes(48).toString('base64url')
}

export function codeChallengeS256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

export function generateState(): string {
  return randomBytes(24).toString('base64url')
}
