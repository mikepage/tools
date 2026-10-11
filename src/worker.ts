// The Worker: every tool as a page and a JSON API, on one Effect runtime.

import { Effect, ManagedRuntime } from "effect"
import { FetchHttpClient } from "effect/http"
import { makeHandler } from "./app/handler.ts"
import { tools } from "./tools/index.ts"

interface Env {
  readonly RATE_LIMIT?: { limit(options: { key: string }): Promise<{ success: boolean }> }
}

// Built once per isolate: the HTTP client the tools use for DoH, RDAP and the rest.
const runtime = ManagedRuntime.make(FetchHttpClient.layer)
const handle = makeHandler(tools)

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    // Only runs cost anything: a page with a query, or an API call.
    if (env.RATE_LIMIT && (url.search !== "" || url.pathname.endsWith("/api"))) {
      const { success } = await env.RATE_LIMIT.limit({ key: request.headers.get("cf-connecting-ip") ?? "unknown" })
      if (!success) return Response.json({ error: "Too many requests, try again in a minute" }, { status: 429 })
    }
    return runtime.runPromise(handle(request).pipe(Effect.withSpan("request")))
  },
} satisfies ExportedHandler<Env>
