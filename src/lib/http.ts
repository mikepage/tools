// Outbound HTTP with fetch: a timeout on every call, and every failure
// (network, timeout, status, body) turned into an UpstreamError.

import { UpstreamError } from "../tools/Tool.ts"

export interface FetchOptions {
  readonly headers?: Record<string, string>
  /** Milliseconds; default 5000. */
  readonly timeout?: number
  /** Names the upstream in error messages, e.g. "DNS lookup of example.com". */
  readonly what: string
  /** Statuses that are an answer, not a failure (e.g. 404 from RDAP). Default: 2xx only. */
  readonly accept?: (status: number) => boolean
}

const describe = (error: unknown): string =>
  error instanceof DOMException && error.name === "TimeoutError"
    ? "no answer in time"
    : error instanceof Error
    ? error.message
    : String(error)

/** Fetches a URL; throws UpstreamError on network errors, timeouts and unaccepted statuses. */
export const get = async (url: string | URL, options: FetchOptions): Promise<Response> => {
  let response: Response
  try {
    response = await fetch(url, {
      headers: options.headers ?? {},
      signal: AbortSignal.timeout(options.timeout ?? 5000),
    })
  } catch (error) {
    throw new UpstreamError(`${options.what} failed: ${describe(error)}`)
  }
  const ok = options.accept ? options.accept(response.status) : response.ok
  if (!ok) throw new UpstreamError(`${options.what} failed: status ${response.status}`)
  return response
}

/** Fetches JSON and checks its shape with `isValid`; throws UpstreamError otherwise. */
export const getJson = async <T>(
  url: string | URL,
  isValid: (value: unknown) => value is T,
  options: FetchOptions,
): Promise<T> => {
  const response = await get(url, options)
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new UpstreamError(`${options.what} failed: the answer is not JSON`)
  }
  if (!isValid(body)) throw new UpstreamError(`${options.what} failed: unexpected answer`)
  return body
}

/** Small shape checks for JSON answers. */
export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
export const isArrayOf = <T>(v: unknown, item: (x: unknown) => x is T): v is Array<T> => Array.isArray(v) && v.every(item)

/** Milliseconds since `start`, rounded. */
export const since = (start: number): number => Math.round(performance.now() - start)
