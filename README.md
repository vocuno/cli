# Vocuno CLI

Command-line client for [Vocuno](https://vocuno.com) — generate AI songs from
your terminal, or from an AI agent. Thin wrapper around Vocuno's remote MCP
server (`https://vocuno.com/mcp`, OAuth 2.1 + PKCE, ~32 tools).

> Song generation consumes credits from your Vocuno account (e.g. Suno: 50
> credits per song). Check your balance with `vocuno credits`.

## Install

```bash
npm i -g vocuno
```

Requires Node.js >= 20.

## Quickstart

```bash
vocuno auth login                    # opens your browser, signs you in
vocuno generate "an upbeat synthwave song about night drives" --wait
vocuno download <task_id> --out ./songs
```

Generation runs asynchronously on Vocuno's servers (typically 1-3 minutes).
`--wait` polls for you; without it you get a `task_id` to check later.

## Commands

### `vocuno auth login`

Signs you in via your browser (OAuth 2.1 authorization code + PKCE against
vocuno.com). The CLI registers itself once via Dynamic Client Registration,
spins up a loopback server on `127.0.0.1`, and stores tokens in
`~/.config/vocuno/credentials.json` (file mode 0600). Refresh tokens rotate on
every use; the CLI refreshes automatically.

```bash
vocuno auth login
vocuno auth login --no-open   # print the sign-in URL instead of opening a browser
vocuno auth status            # who am I? (live check)
vocuno auth logout            # drop tokens (keeps the one-time client registration)
```

### `vocuno tools`

Lists every tool the Vocuno MCP server exposes (song generation, stem
separation, voice conversion, audio editing, mastering, mashups, ...).

```bash
vocuno tools           # name + one-line description
vocuno tools --json    # full definitions, including each tool's input schema
```

### `vocuno call <tool>`

Generic escape hatch: call any MCP tool with raw JSON arguments. This is the
workhorse for scripts and agents — everything the server can do is reachable
here, including tools the CLI has no dedicated command for.

```bash
vocuno call get_credits
vocuno call get_song --args '{"task_id":"abc123"}' --json
vocuno call separate_stems --args '{"audio_url":"https://..."}'
echo '{"prompt":"lofi beat"}' | vocuno call generate_song --args -
```

Output is the tool's JSON payload. Inline images (cover art) are stubbed as
`{"type":"image","mimeType":...,"bytes":...}` so stdout stays parseable. A
tool-level error exits non-zero with the error payload on stdout.

### `vocuno generate "<prompt>"`

Wraps `generate_song`. Two modes:

- **Simple**: describe the song in the prompt.
- **Custom**: provide `--lyrics` (and optionally `--style` / `--title`).

```bash
vocuno generate "a warm acoustic ballad about coming home"
vocuno generate "female vocals, 80s power pop" --provider suno --wait
vocuno generate --lyrics - --style "acoustic folk" --title "Homeward" < lyrics.txt
vocuno generate "epic orchestral theme" --instrumental --provider lyria
vocuno generate "compare this" --providers suno,mureka --wait   # each provider bills separately
```

Options: `--lyrics <text|->`, `--style`, `--title`,
`--provider <suno|mureka|musicgpt|minimax|lyria|udio|wavespeed-ace-step>`,
`--providers <list>`, `--model <id>`, `--instrumental`, `--vocal-gender <m|f>`,
`--negative-tags <tags>`, `--duration <seconds>` (honored by
wavespeed-ace-step and musicgpt only), `--seed <n>` (wavespeed-ace-step only),
`--wait`, `--json`.

Without `--wait` it prints the `task_id` immediately.

### `vocuno song <task_id>`

Wraps `get_song`: status, title, and per-track permanent share links on
vocuno.com. Tracks often get a playable share link *while still generating*
(streaming preview — the same link serves the final version).

```bash
vocuno song abc123
vocuno song abc123 --wait      # polls until complete/cancelled/error; progress on stderr
vocuno song abc123 --json
```

### `vocuno credits`

```bash
vocuno credits
vocuno credits --json    # {"credits_remaining": 1234, ...}
```

### `vocuno download <task_id | vocuno.com URL>`

Saves a finished song's audio to disk with sane filenames (derived from the
track title, collision-safe). Accepts a `generate` task id or a vocuno.com
share link. Non-vocuno.com URLs are refused.

```bash
vocuno download abc123 --out ./songs
vocuno download https://vocuno.com/share/XYZ
```

## Using with AI agents

The CLI is designed to be driven by agents:

- Every command takes `--json` and then prints **data only** on stdout —
  progress and diagnostics go to stderr, errors exit non-zero.
- `vocuno tools --json` returns each tool's full input schema; pair it with
  `vocuno call <tool> --args '<json>' --json` to reach all ~32 server tools
  (stems, voice conversion, mastering, BPM detection, mashups, ...).
- Generation is asynchronous: `vocuno generate ... --json` returns a
  `task_id`; poll `vocuno song <task_id> --json` (or let `--wait` poll for
  you — it polls every 5-15s, since the server itself never holds a long
  request).
- If a command prints `Not signed in. Run: vocuno auth login`, a human needs
  to complete the browser sign-in once; tokens then refresh automatically.

Example agent loop:

```bash
task=$(vocuno generate "8-bit chiptune boss battle" --json | jq -r .task_id)
vocuno song "$task" --wait --json | jq '.tracks[].share_url'
vocuno download "$task" --out ./out
```

Remember: **generation consumes Vocuno credits** — check `vocuno credits
--json` before batching.

## Configuration

| What | Where |
| --- | --- |
| Tokens + client registration | `~/.config/vocuno/credentials.json` (mode 0600; honors `XDG_CONFIG_HOME`) |
| Server origin override | `VOCUNO_BASE_URL` (defaults to `https://vocuno.com`) |
| Credentials path override | `VOCUNO_CREDENTIALS_PATH` |

## Development

```bash
npm install
npm run build       # tsc → dist/
npm test            # build + node:test unit tests (no network)
npm run typecheck
```

## License

MIT © Vocuno LLC
