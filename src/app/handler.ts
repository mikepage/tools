// Routing and running, with URLPattern. Every tool gets:
//
//   GET /<slug>       the page: the form, and the result when there is a query
//   GET /<slug>/api   the same run as JSON: the result, or { error } with 400/502
//
// GET /api.json lists the tools and their parameters (the CLI reads it).

import type { Html } from "../jsx/jsx-runtime.ts"
import { type AnyTool, InputError, type Query, UpstreamError, type Visitor, visitorFrom } from "../tools/Tool.ts"
import { Home, NotFound, type Outcome, ToolPage } from "./pages.tsx"
import { css } from "./styles.ts"

interface Failure {
  readonly status: 400 | 500 | 502
  readonly message: string
}

type Run = { readonly ok: true; readonly input: unknown; readonly result: unknown } | ({ readonly ok: false } & Failure)

/** Parses the query and runs the tool; every failure becomes a status and a message. */
export const runTool = async (tool: AnyTool, query: Query, visitor: Visitor): Promise<Run> => {
  try {
    const input = tool.parse(query, visitor)
    const result = await tool.run(input, visitor)
    return { ok: true, input, result }
  } catch (error) {
    if (error instanceof InputError) return { ok: false, status: 400, message: error.message }
    if (error instanceof UpstreamError) return { ok: false, status: 502, message: error.message }
    // Anything else is a bug in the tool.
    console.error(`${tool.slug} failed`, error)
    return { ok: false, status: 500, message: "Internal error" }
  }
}

const html = (page: Html, status = 200): Response =>
  new Response(page.value, { status, headers: { "content-type": "text/html; charset=utf-8" } })

const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status, headers: { "access-control-allow-origin": "*", "cache-control": "no-store" } })

const withHeaders = (response: Response, headers: Readonly<Record<string, string>> | undefined): Response => {
  for (const [name, value] of Object.entries(headers ?? {})) response.headers.set(name, value)
  return response
}

const HOME = new URLPattern({ pathname: "/" })
const STYLES = new URLPattern({ pathname: "/styles.css" })
const CATALOG = new URLPattern({ pathname: "/api.json" })
const PAGE = new URLPattern({ pathname: "/:slug" })
const API = new URLPattern({ pathname: "/:slug/api" })
const SLASHED = new URLPattern({ pathname: "/:slug/" })

export const makeHandler = (tools: ReadonlyArray<AnyTool>) => {
  const bySlug = new Map(tools.map((t) => [t.slug, t]))

  const catalog = () =>
    tools.map((t) => ({
      slug: t.slug,
      title: t.title,
      summary: t.summary,
      category: t.category,
      params: t.params,
      api: `/${t.slug}/api`,
    }))

  return async (request: Request): Promise<Response> => {
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 })
    const url = new URL(request.url)
    if (HOME.test(url)) return html(Home({ tools }))
    if (STYLES.test(url)) {
      return new Response(css, {
        headers: { "content-type": "text/css; charset=utf-8", "cache-control": "public, max-age=31536000, immutable" },
      })
    }
    if (CATALOG.test(url)) return json(catalog())

    const slashed = SLASHED.exec(url)
    if (slashed && bySlug.has(slashed.pathname.groups["slug"]!)) {
      return Response.redirect(`${url.origin}/${slashed.pathname.groups["slug"]}${url.search}`, 301)
    }

    const api = API.exec(url)
    const page = PAGE.exec(url)
    const tool = bySlug.get((api ?? page)?.pathname.groups["slug"] ?? "")
    if (!tool) return html(NotFound(), 404)

    const query: Query = Object.fromEntries(url.searchParams)
    const visitor = visitorFrom(request)

    if (api) {
      const run = await runTool(tool, query, visitor)
      return withHeaders(run.ok ? json(run.result) : json({ error: run.message }, run.status), tool.responseHeaders)
    }

    let outcome: Outcome = { _tag: "Empty" }
    let status = 200
    if (Object.keys(query).length > 0 || tool.autorun) {
      const run = await runTool(tool, query, visitor)
      outcome = run.ok ? { _tag: "Done", input: run.input, result: run.result } : { _tag: "Failed", message: run.message }
      status = run.ok ? 200 : run.status
    }
    return withHeaders(html(ToolPage({ tool, query, outcome }), status), tool.responseHeaders)
  }
}
