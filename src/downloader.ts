import * as fs from 'node:fs'
import * as path from 'node:path'
import type { CliContext } from './context.js'
import { deriveFilename, isVocunoUrl, shareTokenFromUrl } from './download.js'
import { getSongPayload } from './songs.js'

export interface DownloadTarget {
  title: string | null
  fallback: string
  url: string
}

export interface DownloadedFile {
  path: string
  url: string
  bytes: number
}

interface SharedTrackData {
  title?: string | null
  trackTitle?: string | null
  audioUrl?: string | null
  kind?: 'track' | 'bundle'
  tracks?: Array<{ title?: string | null; label?: string | null; audioUrl?: string | null }>
}

/** Public share resolution (GET /api/shares/:token — no auth required). */
async function resolveShare(ctx: CliContext, token: string): Promise<DownloadTarget[]> {
  const res = await ctx.fetchFn(`${ctx.baseUrl}/api/shares/${encodeURIComponent(token)}`)
  if (res.status === 404) throw new Error('Share not found (or its content no longer exists)')
  if (!res.ok) throw new Error(`Share lookup failed (HTTP ${res.status})`)
  const data = (await res.json()) as SharedTrackData

  if (data.kind === 'bundle' && Array.isArray(data.tracks)) {
    const targets = data.tracks
      .filter((track) => track.audioUrl)
      .map((track) => ({ title: track.title || track.label || null, fallback: token, url: track.audioUrl! }))
    if (targets.length === 0) throw new Error('This share has no downloadable audio')
    return targets
  }
  if (!data.audioUrl) throw new Error('This share has no downloadable audio')
  return [{ title: data.trackTitle || data.title || null, fallback: token, url: data.audioUrl }]
}

/** get_song → per-track audio_url, falling back to resolving its share link. */
async function resolveTask(ctx: CliContext, taskId: string): Promise<DownloadTarget[]> {
  const payload = await getSongPayload(ctx.client, taskId)
  if (payload.error && payload.status !== 'complete') throw new Error(payload.error)
  if (payload.status === 'generating') {
    throw new Error(`Song is still generating. Wait for it with: vocuno song ${taskId} --wait`)
  }

  const tracks = Array.isArray(payload.tracks) ? payload.tracks : []
  const targets: DownloadTarget[] = []
  for (const [index, track] of tracks.entries()) {
    const title = track.title || payload.title || null
    const fallback = `${taskId}-${index + 1}`
    if (track.audio_url) {
      targets.push({ title, fallback, url: track.audio_url })
      continue
    }
    const shareToken = track.share_url ? shareTokenFromUrl(track.share_url) : null
    if (shareToken) {
      try {
        const shared = await resolveShare(ctx, shareToken)
        targets.push(...shared.map((target) => ({ ...target, title: target.title || title, fallback })))
        continue
      } catch {
        // fall through to the warning below
      }
    }
    console.error(`Warning: no downloadable audio for track ${index + 1}${title ? ` ("${title}")` : ''} — skipped`)
  }
  if (targets.length === 0) throw new Error('No downloadable audio found for this song')
  return targets
}

export async function resolveDownloadTargets(ctx: CliContext, arg: string): Promise<DownloadTarget[]> {
  if (arg.includes('://')) {
    const extraHosts = [new URL(ctx.baseUrl).hostname]
    if (!isVocunoUrl(arg, extraHosts)) {
      throw new Error('Only vocuno.com URLs are supported (a share link or a Vocuno-hosted file URL)')
    }
    const token = shareTokenFromUrl(arg)
    if (token) return resolveShare(ctx, token)
    // A Vocuno-hosted direct file URL.
    const pathname = decodeURIComponent(new URL(arg).pathname)
    const base = path.basename(pathname).replace(/\.[a-z0-9]+$/i, '')
    return [{ title: base || null, fallback: 'track', url: arg }]
  }
  return resolveTask(ctx, arg)
}

export async function downloadTargets(targets: DownloadTarget[], outDir: string): Promise<DownloadedFile[]> {
  fs.mkdirSync(outDir, { recursive: true })
  const taken = new Set<string>()
  for (const existing of fs.readdirSync(outDir)) taken.add(existing.toLowerCase())

  const files: DownloadedFile[] = []
  for (const target of targets) {
    const res = await fetch(target.url)
    if (!res.ok) throw new Error(`Download failed (HTTP ${res.status}) for ${target.url}`)
    const buffer = Buffer.from(await res.arrayBuffer())
    const filename = deriveFilename({
      title: target.title,
      fallback: target.fallback,
      url: target.url,
      contentType: res.headers.get('content-type'),
      taken,
    })
    const filePath = path.join(outDir, filename)
    fs.writeFileSync(filePath, buffer)
    files.push({ path: filePath, url: target.url, bytes: buffer.length })
  }
  return files
}
