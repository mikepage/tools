// DNS lookup on Hono + Zod, on Cloudflare Workers: the same tool as
// src/tools/dns-lookup.tsx, written the way most Workers apps are written.
//
// Page at /dns-lookup, JSON at /dns-lookup/api. Same parameters, same result.

import { Hono } from "hono"
import { z } from "zod"

const RECORD_TYPES = ["A", "AAAA", "CNAME", "MX", "NS", "TXT", "SOA", "CAA", "SRV", "PTR"] as const
type RecordType = (typeof RECORD_TYPES)[number]
const TYPE_CODES: Record<RecordType, number> = { A: 1, AAAA: 28, CNAME: 5, MX: 15, NS: 2, TXT: 16, SOA: 6, CAA: 257, SRV: 33, PTR: 12 }
const RESOLVERS = {
  cloudflare: "https://cloudflare-dns.com/dns-query",
  "cloudflare-security": "https://security.cloudflare-dns.com/dns-query",
  "cloudflare-family": "https://family.cloudflare-dns.com/dns-query",
  google: "https://dns.google/resolve",
} as const
const DNS_STATUS: Record<number, string> = { 0: "No error", 1: "Format error", 2: "Server failure", 3: "Non-existent domain", 4: "Not implemented", 5: "Query refused" }

const clean = (s: string) => s.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "").split(/[/?#]/)[0]!.replace(/:\d+$/, "").replace(/\.$/, "")
const LABEL = /^_?[a-z0-9]([a-z0-9-_]{0,61}[a-z0-9])?$/i
const blank = (s: string | undefined) => (s === undefined || s.trim() === "" ? undefined : s)

// Input. Zod covers validation; defaults and the `domain` alias are done by hand.
const Params = z.object({
  name: z.string().transform(clean).refine((n) => n.length <= 253 && n.split(".").length >= 2 && n.split(".").every((l) => LABEL.test(l)), "a domain such as example.com"),
  type: z.string().transform((s) => s.toUpperCase()).pipe(z.enum(RECORD_TYPES)),
  resolver: z.enum(Object.keys(RESOLVERS) as [keyof typeof RESOLVERS]),
  dnssec: z.string().transform((s) => !/^(false|0|off|no|disabled?)$/i.test(s)),
})
type Input = z.infer<typeof Params>

const parse = (q: Record<string, string>) =>
  Params.safeParse({
    name: blank(q.name) ?? blank(q.domain) ?? "",
    type: blank(q.type) ?? "A",
    resolver: blank(q.resolver) ?? "cloudflare",
    dnssec: blank(q.dnssec) ?? "on",
  })

// The resolver's answer. Zod again, so a malformed answer is caught.
const DohResponse = z.object({
  Status: z.number(),
  AD: z.boolean().optional(),
  Answer: z.array(z.object({ name: z.string(), type: z.number(), TTL: z.number(), data: z.string() })).optional(),
})

// A failing resolver must be a 502, not a 500, so it gets its own error class.
class UpstreamError extends Error {}

async function lookup(input: Input) {
  const url = new URL(RESOLVERS[input.resolver])
  url.searchParams.set("name", input.name)
  url.searchParams.set("type", input.type)
  url.searchParams.set(input.dnssec ? "do" : "cd", "1")
  const started = Date.now()
  let body: unknown
  try {
    const res = await fetch(url, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(5000) })
    if (!res.ok) throw new Error(`status ${res.status}`)
    body = await res.json()
  } catch (e) {
    throw new UpstreamError(`DNS lookup of ${input.name} ${input.type} failed: ${e instanceof Error ? e.message : e}`)
  }
  const parsed = DohResponse.safeParse(body)
  if (!parsed.success) throw new UpstreamError(`DNS lookup of ${input.name} ${input.type} failed: unexpected answer`)
  const response = parsed.data
  return {
    name: input.name,
    type: input.type,
    resolver: input.resolver,
    status: response.Status,
    statusText: DNS_STATUS[response.Status] ?? `DNS error ${response.Status}`,
    queryTime: Date.now() - started,
    dnssec: { enabled: input.dnssec, validated: response.AD === true },
    records: (response.Answer ?? []).filter((a) => a.type === TYPE_CODES[input.type]).map((a) => ({ ttl: a.TTL, value: a.data.replace(/\.$/, "") })),
    raw: response,
  }
}

// Runs a lookup and sorts every failure into a status code.
async function run(q: Record<string, string>) {
  const parsed = parse(q)
  if (!parsed.success) return { status: 400 as const, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ") }
  try {
    return { status: 200 as const, result: await lookup(parsed.data) }
  } catch (e) {
    if (e instanceof UpstreamError) return { status: 502 as const, error: e.message }
    console.error(e)
    return { status: 500 as const, error: "Internal error" }
  }
}

const app = new Hono()

app.get("/dns-lookup/api", async (c) => {
  const outcome = await run(c.req.query())
  return "result" in outcome ? c.json(outcome.result) : c.json({ error: outcome.error }, outcome.status)
})

app.get("/dns-lookup", async (c) => {
  const q = c.req.query()
  const outcome = Object.keys(q).length ? await run(q) : undefined
  return c.html(
    <html>
      <body>
        <h1>DNS lookup</h1>
        <form method="get">
          <input name="name" value={q.name ?? ""} placeholder="example.com" />
          <select name="type">{RECORD_TYPES.map((t) => <option selected={t === (q.type ?? "A").toUpperCase()}>{t}</option>)}</select>
          <button>Run</button>
        </form>
        {outcome && "error" in outcome && <p>Error: {outcome.error}</p>}
        {outcome?.result && (
          <table>
            {outcome.result.records.map((r) => <tr><td>{r.value}</td><td>{r.ttl}</td></tr>)}
          </table>
        )}
      </body>
    </html>,
    outcome?.status ?? 200,
  )
})

export default app
