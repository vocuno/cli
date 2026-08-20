import assert from 'node:assert/strict'
import { createHash, timingSafeEqual } from 'node:crypto'
import { test } from 'node:test'
import { codeChallengeS256, generateCodeVerifier, generateState } from '../pkce.js'

/** Mirror of the server's verifyPkceS256 (functions/src/modules/mcp/domain/mcp-oauth.ts). */
function serverVerifyPkceS256(codeVerifier: string, codeChallenge: string): boolean {
  if (!codeVerifier || !codeChallenge) return false
  if (codeVerifier.length < 43 || codeVerifier.length > 128) return false
  const derived = createHash('sha256').update(codeVerifier).digest('base64url')
  const left = Buffer.from(derived)
  const right = Buffer.from(codeChallenge)
  return left.length === right.length && timingSafeEqual(left, right)
}

test('verifier uses the RFC 7636 unreserved charset at a valid length', () => {
  for (let i = 0; i < 20; i++) {
    const verifier = generateCodeVerifier()
    assert.match(verifier, /^[A-Za-z0-9\-._~]{43,128}$/)
  }
})

test('verifiers are unique', () => {
  const seen = new Set(Array.from({ length: 100 }, () => generateCodeVerifier()))
  assert.equal(seen.size, 100)
})

test('challenge is BASE64URL(SHA256(verifier)) and passes the server check', () => {
  const verifier = generateCodeVerifier()
  const challenge = codeChallengeS256(verifier)
  assert.equal(challenge, createHash('sha256').update(verifier).digest('base64url'))
  assert.equal(serverVerifyPkceS256(verifier, challenge), true)
  assert.equal(serverVerifyPkceS256(generateCodeVerifier(), challenge), false)
})

test('state is url-safe and non-trivial', () => {
  const state = generateState()
  assert.match(state, /^[A-Za-z0-9_-]{20,}$/)
})
