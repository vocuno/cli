import { AuthRequiredError } from './errors.js'

/** Machine-readable stdout: data only, pretty-printed JSON. */
export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2))
}

export function firstLine(text: string | undefined): string {
  const line = (text || '').split('\n')[0].trim()
  return line.length > 100 ? `${line.slice(0, 99)}…` : line
}

/**
 * Uniform command wrapper: friendly auth hint, errors to stderr, non-zero
 * exit, no stack traces.
 */
export async function runAction(fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
  } catch (err) {
    if (err instanceof AuthRequiredError) {
      console.error('Not signed in. Run: vocuno auth login')
      process.exit(1)
    }
    const message = err instanceof Error ? err.message : String(err)
    console.error(`Error: ${message}`)
    process.exit(1)
  }
}
