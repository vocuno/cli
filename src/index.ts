#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { Command, Option } from 'commander'
import { getCredentialsPath } from './config.js'
import { createContext } from './context.js'
import { downloadTargets, resolveDownloadTargets } from './downloader.js'
import { AuthRequiredError } from './errors.js'
import { presentToolResult, primaryPayload } from './mcp.js'
import { login } from './oauth.js'
import { firstLine, printJson, runAction } from './output.js'
import { collectTaskIds, getSongPayload, printSongHuman, waitForSong, type SongPayload } from './songs.js'
import { getCliVersion } from './version.js'

const PROVIDERS = ['suno', 'mureka', 'musicgpt', 'minimax', 'lyria', 'udio', 'wavespeed-ace-step'] as const

const program = new Command()

program
  .name('vocuno')
  .description('Command-line client for Vocuno (vocuno.com) — generate AI songs from your terminal.')
  .version(getCliVersion())
  .addHelpText(
    'after',
    `
Examples:
  vocuno auth login
  vocuno tools
  vocuno generate "an upbeat synthwave song about night drives" --wait
  vocuno generate --lyrics - --style "acoustic folk" --title "Homeward" < lyrics.txt
  vocuno song <task_id> --wait
  vocuno credits
  vocuno download <task_id> --out ./songs
  vocuno call get_song --args '{"task_id":"abc123"}' --json

Song generation consumes credits from your Vocuno account.`,
  )

// --- auth ------------------------------------------------------------------

const auth = program.command('auth').description('Sign in / out of your Vocuno account')

auth
  .command('login')
  .description('Sign in with your browser (OAuth 2.1 + PKCE)')
  .option('--no-open', 'print the sign-in URL instead of opening a browser')
  .action(async (opts: { open: boolean }) =>
    runAction(async () => {
      const ctx = createContext()
      const creds = await login({ baseUrl: ctx.baseUrl, store: ctx.store, fetchFn: ctx.fetchFn, open: opts.open })
      console.log(creds.email ? `Signed in as ${creds.email}` : 'Signed in.')
      console.log(`Credentials saved to ${ctx.store.filePath}`)
    }),
  )

auth
  .command('status')
  .description('Show who is signed in')
  .option('--json', 'machine-readable output')
  .action(async (opts: { json?: boolean }) =>
    runAction(async () => {
      const ctx = createContext()
      const creds = ctx.store.load()
      if (!creds?.refreshToken && !creds?.accessToken) throw new AuthRequiredError()

      // Live check (auto-refreshes if the access token expired). The
      // /oauth/userinfo endpoint may not be routed on every server build
      // (Hosting rewrites), so fall back to an MCP call to prove the session.
      let info: { sub?: string; email?: string } = {}
      const userinfoUrl = creds.userinfoEndpoint || `${ctx.baseUrl}/oauth/userinfo`
      let live = false
      try {
        const res = await ctx.tokens.authedFetch(userinfoUrl)
        if (res.ok && (res.headers.get('content-type') ?? '').includes('application/json')) {
          info = (await res.json()) as { sub?: string; email?: string }
          live = true
        }
      } catch {
        /* fall through to the MCP probe */
      }
      if (!live) {
        const probe = await ctx.client.callTool('get_credits')
        if (probe.isError) throw new Error('Could not verify the session')
      }
      const latest = ctx.store.load() ?? creds
      const email = info.email || latest.email

      if (opts.json) {
        printJson({
          signed_in: true,
          email: email ?? null,
          uid: info.sub ?? latest.uid ?? null,
          base_url: ctx.baseUrl,
          access_token_expires_at: latest.expiresAt ?? null,
          credentials_path: ctx.store.filePath,
        })
        return
      }
      console.log(email ? `Signed in as ${email}` : 'Signed in.')
      console.log(`Server:      ${ctx.baseUrl}`)
      console.log(`Credentials: ${ctx.store.filePath}`)
    }),
  )

auth
  .command('logout')
  .description('Sign out (removes stored tokens)')
  .action(async () =>
    runAction(async () => {
      const ctx = createContext()
      ctx.store.clearTokens()
      console.log('Signed out.')
    }),
  )

// --- tools -----------------------------------------------------------------

program
  .command('tools')
  .description('List the tools exposed by the Vocuno MCP server')
  .option('--json', 'full tool definitions as JSON')
  .action(async (opts: { json?: boolean }) =>
    runAction(async () => {
      const ctx = createContext()
      const tools = await ctx.client.listTools()
      if (opts.json) {
        printJson(tools)
        return
      }
      const width = Math.max(...tools.map((tool) => tool.name.length), 4)
      for (const tool of tools) {
        console.log(`${tool.name.padEnd(width)}  ${firstLine(tool.description)}`)
      }
    }),
  )

// --- call (generic escape hatch) -------------------------------------------

program
  .command('call')
  .description('Call any MCP tool directly (see `vocuno tools` for names and schemas)')
  .argument('<tool>', 'tool name, e.g. generate_song')
  .option('--args <json>', "tool arguments as a JSON object ('-' reads JSON from stdin)", '{}')
  .option('--json', 'machine-readable output')
  .action(async (tool: string, opts: { args: string; json?: boolean }) =>
    runAction(async () => {
      const raw = opts.args === '-' ? readFileSync(0, 'utf8') : opts.args
      let args: Record<string, unknown>
      try {
        args = JSON.parse(raw)
      } catch {
        throw new Error('--args must be a valid JSON object')
      }
      if (!args || typeof args !== 'object' || Array.isArray(args)) {
        throw new Error('--args must be a JSON object, e.g. \'{"task_id":"abc"}\'')
      }
      const ctx = createContext()
      const result = await ctx.client.callTool(tool, args)
      printJson(presentToolResult(result))
      if (result.isError) process.exit(1)
    }),
  )

// --- generate --------------------------------------------------------------

program
  .command('generate')
  .description('Generate an AI song (wraps the generate_song tool; costs credits)')
  .argument('[prompt]', 'description of the song (genre, mood, topic, language)')
  .option('--lyrics <text>', "custom mode: full lyrics to sing ('-' reads from stdin)")
  .option('--style <text>', 'custom mode: musical style/genre tags')
  .option('--title <text>', 'custom mode: song title')
  .addOption(new Option('--provider <provider>', 'music provider (default: suno)').choices(PROVIDERS))
  .option('--providers <list>', 'comparison mode: comma-separated providers (each bills separately)')
  .option('--model <id>', "provider-specific model id (e.g. Suno 'V5', 'mureka-v9')")
  .option('--instrumental', 'generate an instrumental (no vocals)')
  .addOption(new Option('--vocal-gender <gender>', 'preferred vocal gender').choices(['m', 'f']))
  .option('--negative-tags <tags>', 'styles to avoid, comma-separated')
  .option('--duration <seconds>', 'requested duration in seconds (wavespeed-ace-step 5-240, musicgpt 10-300)', parseFloat)
  .option('--seed <n>', 'wavespeed-ace-step only: seed for reproducible generation', (value) => parseInt(value, 10))
  .option('--wait', 'poll get_song until generation finishes')
  .option('--json', 'machine-readable output')
  .action(
    async (
      prompt: string | undefined,
      opts: {
        lyrics?: string
        style?: string
        title?: string
        provider?: string
        providers?: string
        model?: string
        instrumental?: boolean
        vocalGender?: string
        negativeTags?: string
        duration?: number
        seed?: number
        wait?: boolean
        json?: boolean
      },
    ) =>
      runAction(async () => {
        const lyrics = opts.lyrics === '-' ? readFileSync(0, 'utf8') : opts.lyrics
        if (!prompt && !lyrics) throw new Error('Provide a prompt (simple mode) or --lyrics (custom mode)')

        const args: Record<string, unknown> = {}
        if (prompt) args.prompt = prompt
        if (lyrics) args.lyrics = lyrics
        if (opts.style) args.style = opts.style
        if (opts.title) args.title = opts.title
        if (opts.provider) args.provider = opts.provider
        if (opts.providers) {
          const providers = opts.providers.split(',').map((p) => p.trim()).filter(Boolean)
          const unknown = providers.filter((p) => !(PROVIDERS as readonly string[]).includes(p))
          if (unknown.length) throw new Error(`Unknown provider(s): ${unknown.join(', ')}. Choices: ${PROVIDERS.join(', ')}`)
          args.providers = providers
        }
        if (opts.model) args.model = opts.model
        if (opts.instrumental) args.instrumental = true
        if (opts.vocalGender) args.vocal_gender = opts.vocalGender
        if (opts.negativeTags) args.negative_tags = opts.negativeTags
        if (opts.duration !== undefined) args.duration = opts.duration
        if (opts.seed !== undefined) args.seed = opts.seed

        const ctx = createContext()
        const result = await ctx.client.callTool('generate_song', args)
        const payload = primaryPayload(result) as Record<string, any>
        if (result.isError || payload?.error) {
          if (opts.json) printJson(payload)
          else console.error(`Error: ${payload?.error ?? 'generate_song failed'}`)
          process.exit(1)
        }

        const taskIds = collectTaskIds(payload)
        if (!opts.wait) {
          if (opts.json) {
            printJson(payload)
            return
          }
          for (const taskId of taskIds) console.log(`Task started: ${taskId}`)
          if (taskIds.length > 0) console.log(`\nFollow progress with: vocuno song ${taskIds[0]} --wait`)
          return
        }

        if (taskIds.length === 0) throw new Error('generate_song returned no task_id to wait on')
        const finals: SongPayload[] = []
        for (const taskId of taskIds) finals.push(await waitForSong(ctx.client, taskId))
        if (opts.json) {
          printJson(finals.length === 1 ? finals[0] : finals)
          return
        }
        finals.forEach((final, index) => {
          if (index > 0) console.log('')
          printSongHuman(final)
        })
      }),
  )

// --- song ------------------------------------------------------------------

program
  .command('song')
  .description('Check a song generation (wraps the get_song tool)')
  .argument('<task_id>', 'the task_id returned by generate')
  .option('--wait', 'poll until the song reaches a terminal state')
  .option('--json', 'machine-readable output')
  .action(async (taskId: string, opts: { wait?: boolean; json?: boolean }) =>
    runAction(async () => {
      const ctx = createContext()
      const payload = opts.wait ? await waitForSong(ctx.client, taskId) : await getSongPayload(ctx.client, taskId)
      if (opts.json) {
        printJson(payload)
        return
      }
      printSongHuman(payload)
    }),
  )

// --- credits ---------------------------------------------------------------

program
  .command('credits')
  .description('Show your remaining Vocuno credit balance')
  .option('--json', 'machine-readable output')
  .action(async (opts: { json?: boolean }) =>
    runAction(async () => {
      const ctx = createContext()
      const result = await ctx.client.callTool('get_credits')
      const payload = primaryPayload(result) as Record<string, any>
      if (result.isError || payload?.error) throw new Error(payload?.error ?? 'get_credits failed')
      if (opts.json) {
        printJson(payload)
        return
      }
      console.log(`Credits remaining: ${payload?.credits_remaining}`)
      if (payload?.note) console.log(payload.note)
    }),
  )

// --- download --------------------------------------------------------------

program
  .command('download')
  .description('Download the audio of a finished song to disk')
  .argument('<task_id_or_url>', 'a generate task_id, or a vocuno.com share/file URL')
  .option('--out <dir>', 'output directory', '.')
  .option('--json', 'machine-readable output')
  .action(async (arg: string, opts: { out: string; json?: boolean }) =>
    runAction(async () => {
      const ctx = createContext()
      const targets = await resolveDownloadTargets(ctx, arg)
      const files = await downloadTargets(targets, opts.out)
      if (opts.json) {
        printJson({ files })
        return
      }
      for (const file of files) console.log(`Saved ${file.path} (${Math.round(file.bytes / 1024)} KB)`)
    }),
  )

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
