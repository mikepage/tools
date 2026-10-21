// The tools as a Void app: routes/ serves every tool, middleware/ rate-limits
// the runs. The Worker keeps its name, rate limit and custom domain.

import { defineConfig } from "void/config"

export default defineConfig({
  worker: {
    compatibility_date: "2026-09-30",
    // No nodejs_compat. Void adds nodejs_als itself, for its request context.
    compatibility_flags: [],
  },
  routing: {
    // Every page is rendered per request; there is nothing to cache or prerender.
    isr: false,
    // Unknown paths fall through to routes/[...path].ts, the tools' own 404 page.
    notFound: "none",
  },
  cloudflare: {
    name: "tools",
    ratelimits: [{ name: "RATE_LIMIT", namespace_id: "1004", simple: { limit: 60, period: 60 } }],
    routes: [{ pattern: "tools.mikepage.nl", custom_domain: true }],
    // As the Worker has them in Cloudflare; Void won't republish visibility it can't see.
    workers_dev: true,
    preview_urls: false,
    observability: { enabled: true },
  },
})
