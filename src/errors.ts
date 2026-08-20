/** The user has no usable session. The CLI turns this into a friendly hint. */
export class AuthRequiredError extends Error {
  constructor(message = 'Not signed in') {
    super(message)
    this.name = 'AuthRequiredError'
  }
}

/** Non-JSON-RPC HTTP failure talking to the server. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}
