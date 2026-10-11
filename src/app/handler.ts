// Routing and running. Every tool gets:
//
//   GET /<slug>       the page: the form, and the result when there is a query
//   GET /<slug>/api   the same run as JSON: the result, or { error } with 400/502
//
// The query string is read from the raw URL and decoded by the tool's Schema.

import { Cause, Effect, Schema } from "effect"
import type { Html } from "../jsx/jsx-runtime.ts"
import { type AnyTool, type Query, Visitor } from "../tools/Tool.ts"
import { Home, NotFound, type Outcome, ToolPage } from "./pages.tsx"
import { css } from "./styles.ts"

interface Failure {
  readonly status: 400 | 500 | 502
  readonly message: string
}

/** `invalid domain\n  at ["name"]` -> `name: invalid domain`, one line per issue. */
export const formatSchemaError = (message: string): string => {
  const lines = message.split("\n")
  const out: Array<string> = []
  for (let i = 0; i < lines.length; i++) {
    const at = lines[i + 1]?.match(/^\s*at \[(.*)\]$/)
    if (at) {
      const path = at[1]!.split(",").map((p) => p.trim().replace(/^"|"$/g, "")).join(".")
      out.push(`${path}: ${lines[i]!.trim()}`)
      i++
    } else if (lines[i]!.trim()) out.push(lines[i]!.trim())
  }
  return out.join("; ")
}

/** Decodes the query and runs the tool; every failure becomes a status and a message. */
export const runTool = (tool: AnyTool, query: Query) =>
  Effect.gen(function*() {
    const input = yield* Schema.decodeUnknownEffect(tool.params)(query)
    const result = yield* tool.run(input)
    return { input, result }
  }).pipe(
    Effect.catchTags({
      SchemaError: (e) => Effect.fail<Failure>({ status: 400, message: formatSchemaError(e.message) }),
      InputError: (e) => Effect.fail<Failure>({ status: 400, message: e.message }),
      UpstreamError: (e) => Effect.fail<Failure>({ status: 502, message: e.message }),
    }),
    // A defect is a bug in the tool: log it, answer 500.
    Effect.catchDefect((defect) =>
      Effect.logError(`${tool.slug} failed`, Cause.pretty(Cause.die(defect))).pipe(
        Effect.andThen(Effect.fail<Failure>({ status: 500, message: "Internal error" })),
      )
    ),
  )

const html = (page: Html, status = 200): Response =>
  new Response(page.value, { status, headers: { "content-type": "text/html; charset=utf-8" } })

const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status, headers: { "access-control-allow-origin": "*", "cache-control": "no-store" } })

const withHeaders = (response: Response, headers: Readonly<Record<string, string>> | undefined): Response => {
  for (const [name, value] of Object.entries(headers ?? {})) response.headers.set(name, value)
  return response
}

export const makeHandler = (tools: ReadonlyArray<AnyTool>) => {
  const bySlug = new Map(tools.map((t) => [t.slug, t]))
  return (request: Request) => route(request).pipe(Effect.map((response) => {
    const tool = bySlug.get(new URL(request.url).pathname.split("/")[1] ?? "")
    return response.status < 300 || response.status >= 400 ? withHeaders(response, tool?.responseHeaders) : response
  }))

  function route(request: Request) {
    return Effect.gen(function*() {
      const url = new URL(request.url)
      if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 })
      if (url.pathname === "/") return html(Home({ tools }))
      if (url.pathname === "/styles.css") {
        return new Response(css, { headers: { "content-type": "text/css; charset=utf-8", "cache-control": "public, max-age=31536000, immutable" } })
      }

      const [, slug = "", rest = "", ...more] = url.pathname.split("/")
      const tool = bySlug.get(slug)
      if (!tool || more.length > 0 || (rest !== "" && rest !== "api")) return html(NotFound(), 404)
      if (url.pathname.endsWith("/") && rest === "") return Response.redirect(`${url.origin}/${slug}${url.search}`, 301)

      const query: Query = Object.fromEntries(url.searchParams)
      const run = runTool(tool, query).pipe(Effect.provideService(Visitor, Visitor.fromRequest(request)))

      if (rest === "api") {
        return yield* run.pipe(
          Effect.match({
            onSuccess: ({ result }) => json(result),
            onFailure: (f) => json({ error: f.message }, f.status),
          }),
        )
      }

      if (Object.keys(query).length === 0 && !tool.autorun) {
        return html(ToolPage({ tool, query, outcome: { _tag: "Empty" } }))
      }
      const [outcome, status] = yield* run.pipe(
        Effect.match({
          onSuccess: ({ input, result }): readonly [Outcome, number] => [{ _tag: "Done", input, result }, 200],
          onFailure: (f): readonly [Outcome, number] => [{ _tag: "Failed", message: f.message }, f.status],
        }),
      )
      return html(ToolPage({ tool, query, outcome }), status)
    })
  }
}
