import * as path from 'node:path'

const EXTENSION_BY_MIME: Record<string, string> = {
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/wave': '.wav',
  'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/aac': '.aac',
  'audio/ogg': '.ogg',
  'audio/flac': '.flac',
  'audio/x-flac': '.flac',
  'audio/webm': '.webm',
}

const KNOWN_EXTENSIONS = new Set(Object.values(EXTENSION_BY_MIME))

/** Strip path separators, control chars and Windows-reserved punctuation. */
export function sanitizeFilename(name: string): string {
  return name
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[/\\:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 120)
    .trim()
}

/** Audio extension from the URL path (handles %2F-encoded GCS object paths), else the content-type, else .mp3. */
export function inferExtension(url?: string | null, contentType?: string | null): string {
  if (url) {
    try {
      const pathname = decodeURIComponent(new URL(url).pathname)
      const ext = path.extname(pathname).toLowerCase()
      if (KNOWN_EXTENSIONS.has(ext)) return ext
    } catch {
      // not a URL — fall through
    }
  }
  if (contentType) {
    const mime = contentType.split(';')[0].trim().toLowerCase()
    const ext = EXTENSION_BY_MIME[mime]
    if (ext) return ext
  }
  return '.mp3'
}

export interface DeriveFilenameOptions {
  title?: string | null
  fallback: string
  url?: string | null
  contentType?: string | null
  /** Lowercased names already used (existing files + earlier tracks). Mutated. */
  taken: Set<string>
}

/** Sane, collision-free filename for a downloaded track. */
export function deriveFilename(options: DeriveFilenameOptions): string {
  const base = sanitizeFilename(options.title || '') || sanitizeFilename(options.fallback) || 'track'
  const ext = inferExtension(options.url, options.contentType)
  let candidate = `${base}${ext}`
  let n = 1
  while (options.taken.has(candidate.toLowerCase())) candidate = `${base} (${n++})${ext}`
  options.taken.add(candidate.toLowerCase())
  return candidate
}

/** Only vocuno.com (and the staging stack / an explicit base override) may be passed to `vocuno download <url>`. */
export function isVocunoUrl(raw: string, extraHosts: string[] = []): boolean {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:') return false
    const host = url.hostname.toLowerCase()
    if (host === 'vocuno.com' || host.endsWith('.vocuno.com')) return true
    if (host === 'vocuno-staging.web.app') return true
    return extraHosts.map((h) => h.toLowerCase()).includes(host)
  } catch {
    return false
  }
}

/** Share token from a vocuno.com/share/<token> URL, else null. */
export function shareTokenFromUrl(raw: string): string | null {
  try {
    const url = new URL(raw)
    const match = url.pathname.match(/^\/share\/([^/]+)\/?$/)
    return match ? decodeURIComponent(match[1]) : null
  } catch {
    return null
  }
}
