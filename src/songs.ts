import { AuthRequiredError } from './errors.js'
import { McpClient, primaryPayload } from './mcp.js'

/** Firebase Hosting caps requests at 60s — all waiting is client-side polling. */
const INITIAL_DELAY_MS = 5_000
const MAX_DELAY_MS = 15_000
const POLL_TIMEOUT_MS = 15 * 60 * 1000
const MAX_TRANSIENT_FAILURES = 5

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export interface SongTrack {
  id?: string
  title?: string | null
  share_url?: string | null
  audio_url?: string | null
  lyrics?: string | null
  duration?: number | null
  preview?: boolean
}

export interface SongPayload {
  task_id?: string
  status?: string
  title?: string | null
  provider?: string
  error?: string
  hint?: string
  tracks?: SongTrack[]
  [key: string]: unknown
}

export async function getSongPayload(client: McpClient, taskId: string): Promise<SongPayload> {
  const result = await client.callTool('get_song', { task_id: taskId })
  const payload = primaryPayload(result)
  if (!payload || typeof payload !== 'object') throw new Error('Empty response from get_song')
  return payload as SongPayload
}

/**
 * Poll get_song until the run leaves "generating" (complete, cancelled, or
 * error). Progress goes to stderr; the terminal payload is returned.
 */
export async function waitForSong(client: McpClient, taskId: string): Promise<SongPayload> {
  const started = Date.now()
  let delayMs = INITIAL_DELAY_MS
  let transientFailures = 0

  for (;;) {
    let payload: SongPayload | null = null
    try {
      payload = await getSongPayload(client, taskId)
      transientFailures = 0
    } catch (err) {
      if (err instanceof AuthRequiredError) throw err
      if (++transientFailures >= MAX_TRANSIENT_FAILURES) throw err
      const message = err instanceof Error ? err.message : String(err)
      console.error(`  poll failed (${message}) — retrying...`)
    }

    if (payload) {
      if (payload.status !== 'generating') return payload
      const elapsed = Math.round((Date.now() - started) / 1000)
      const tracks = Array.isArray(payload.tracks) ? payload.tracks : []
      const previews = tracks.filter((t) => t.share_url).length
      console.error(`[${elapsed}s] ${taskId}: generating (tracks: ${tracks.length}, previews ready: ${previews})`)
    }

    if (Date.now() - started > POLL_TIMEOUT_MS) {
      throw new Error(`Timed out waiting for ${taskId} after 15 minutes. Check later with: vocuno song ${taskId}`)
    }
    await sleep(delayMs)
    delayMs = Math.min(Math.round(delayMs * 1.5), MAX_DELAY_MS)
  }
}

function formatDuration(seconds: number | null | undefined): string {
  if (!seconds || !Number.isFinite(seconds)) return ''
  const total = Math.round(seconds)
  return ` (${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')})`
}

export function printSongHuman(payload: SongPayload): void {
  if (payload.task_id) console.log(`Task:     ${payload.task_id}`)
  if (payload.status) console.log(`Status:   ${payload.status}`)
  if (payload.title) console.log(`Title:    ${payload.title}`)
  if (payload.provider) console.log(`Provider: ${payload.provider}`)
  if (payload.error) console.log(`Error:    ${payload.error}`)

  const tracks = Array.isArray(payload.tracks) ? payload.tracks : []
  if (tracks.length > 0) {
    console.log('Tracks:')
    tracks.forEach((track, index) => {
      const name = track.title || `Track ${index + 1}`
      console.log(`  ${index + 1}. ${name}${formatDuration(track.duration)}`)
      if (track.share_url) console.log(`     ${track.share_url}`)
    })
  }
  if (payload.hint) console.log(`\n${payload.hint}`)
}

/** generate_song returns { task_id } (single) or { tasks: [{ task_id }] } (comparison). */
export function collectTaskIds(payload: Record<string, any>): string[] {
  if (typeof payload?.task_id === 'string' && payload.task_id) return [payload.task_id]
  if (Array.isArray(payload?.tasks)) {
    return payload.tasks.map((task: any) => task?.task_id).filter((id: unknown): id is string => typeof id === 'string')
  }
  return []
}
