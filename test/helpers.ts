import { ManagedRuntime } from "effect"
import { FetchHttpClient } from "effect/http"
import { afterAll } from "vitest"
import { makeHandler } from "../src/app/handler.ts"
import { tools } from "../src/tools/index.ts"

const runtime = ManagedRuntime.make(FetchHttpClient.layer)
const handle = makeHandler(tools)
afterAll(() => runtime.dispose())

/** Sends a GET to the app and returns status, headers and body text. */
export const get = async (path: string, headers: Record<string, string> = {}) => {
  const response = await runtime.runPromise(handle(new Request(`https://tools.test${path}`, { headers })))
  return { status: response.status, headers: response.headers, text: await response.text() }
}
