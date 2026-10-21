// Only runs cost anything: a page with a query, or an API call. Those are
// limited per client IP by the RATE_LIMIT binding, which tests and local
// development don't have.

import { defineMiddleware } from "void"

export default defineMiddleware(async (c, next) => {
  const limiter = (c.env as { RATE_LIMIT?: RateLimit }).RATE_LIMIT
  const url = new URL(c.req.url)
  if (limiter && (url.search !== "" || url.pathname.endsWith("/api"))) {
    const { success } = await limiter.limit({ key: c.req.header("cf-connecting-ip") ?? "unknown" })
    if (!success) return Response.json({ error: "Too many requests, try again in a minute" }, { status: 429 })
  }
  await next()
})
