// The Worker: every tool as a page and a JSON API. No runtime dependencies.

import { makeHandler } from "./app/handler.ts"
import { tools } from "./tools/index.ts"

interface Env {
  readonly RATE_LIMIT?: RateLimit
}

const handle = makeHandler(tools)

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url)
    // Only runs cost anything: a page with a query, or an API call.
    if (env.RATE_LIMIT && (url.search !== "" || url.pathname.endsWith("/api"))) {
      const { success } = await env.RATE_LIMIT.limit({ key: request.headers.get("cf-connecting-ip") ?? "unknown" })
      if (!success) return Response.json({ error: "Too many requests, try again in a minute" }, { status: 429 })
    }
    return handle(request)
  },
} satisfies ExportedHandler<Env>
