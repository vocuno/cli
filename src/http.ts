import { platform } from 'node:os'
import { getCliVersion } from './version.js'

/**
 * User-Agent every CLI request carries, e.g.
 * `vocuno-cli/0.1.1 (darwin; node/22.1.0)`. The server uses the prefix to
 * tell CLI traffic apart from other MCP clients and to see version spread.
 * No other telemetry is sent.
 */
export function buildUserAgent(version: string = getCliVersion()): string {
  return `vocuno-cli/${version} (${platform()}; node/${process.versions.node})`
}

/** `fetch` that injects the CLI User-Agent unless the caller set one. */
export function createCliFetch(baseFetch: typeof fetch = fetch, userAgent: string = buildUserAgent()): typeof fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers)
    if (!headers.has('User-Agent')) headers.set('User-Agent', userAgent)
    return baseFetch(input, { ...init, headers })
  }
}
