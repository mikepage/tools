// DNS lookup on Deno, the way it ran on Deno Deploy: Deno.serve, the
// standard library, and nothing from npm. The same tool as
// src/tools/dns-lookup.tsx.
//
// Page at /dns-lookup, JSON at /dns-lookup/api. Same parameters, same result.
//   deno run --allow-net main.ts

import { escape } from "@std/html/entities"

const RECORD_TYPES = ["A", "AAAA", "CNAME", "MX", "NS", "TXT", "SOA", "CAA", "SRV", "PTR"] as const
type RecordType = (typeof RECORD_TYPES)[number]
const TYPE_CODES: Record<RecordType, number> = { A: 1, AAAA: 28, CNAME: 5, MX: 15, NS: 2, TXT: 16, SOA: 6, CAA: 257, SRV: 33, PTR: 12 }
const RESOLVERS = {
  cloudflare: "https://cloudflare-dns.com/dns-query",
  "cloudflare-security": "https://security.cloudflare-dns.com/dns-query",
  "cloudflare-family": "https://family.cloudflare-dns.com/dns-query",
  google: "https://dns.google/resolve",
} as const
type Resolver = keyof typeof RESOLVERS
const DNS_STATUS: Record<number, string> = { 0: "No error", 1: "Format error", 2: "Server failure", 3: "Non-existent domain", 4: "Not implemented", 5: "Query refused" }

const clean = (s: string) => s.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "").split(/[/?#]/)[0]!.replace(/:\d+$/, "").replace(/\.$/, "")
const LABEL = /^_?[a-z0-9]([a-z0-9-_]{0,61}[a-z0-9])?$/i
const blank = (s: string | null) => (s === null || s.trim() === "" ? undefined : s)

interface Input {
  name: string
  type: RecordType
  resolver: Resolver
  dnssec: boolean
}

// Input. std has no validation library, so this is written by hand.
function parse(q: URLSearchParams): { input: Input } | { error: string } {
  const name = clean(blank(q.get("name")) ?? blank(q.get("domain")) ?? "")
  const labels = name.split(".")
  if (name.length > 253 || labels.length < 2 || !labels.every((l) => LABEL.test(l))) return { error: "name: expected a domain such as example.com" }
  const type = (blank(q.get("type")) ?? "A").toUpperCase()
  if (!(RECORD_TYPES as readonly string[]).includes(type)) return { error: `type: expected one of ${RECORD_TYPES.join(", ")}` }
  const resolver = blank(q.get("resolver")) ?? "cloudflare"
  if (!(resolver in RESOLVERS)) return { error: `resolver: expected one of ${Object.keys(RESOLVERS).join(", ")}` }
  const dnssec = !/^(false|0|off|no|disabled?)$/i.test(blank(q.get("dnssec")) ?? "on")
  return { input: { name, type: type as RecordType, resolver: resolver as Resolver, dnssec } }
}

interface DohResponse {
  Status: number
  AD?: boolean
  Answer?: Array<{ name: string; type: number; TTL: number; data: string }>
}

class UpstreamError extends Error {}

async function lookup(input: Input) {
  const url = new URL(RESOLVERS[input.resolver])
  url.searchParams.set("name", input.name)
  url.searchParams.set("type", input.type)
  url.searchParams.set(input.dnssec ? "do" : "cd", "1")
  const started = Date.now()
  let response: DohResponse
  try {
    const res = await fetch(url, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(5000) })
    if (!res.ok) throw new Error(`status ${res.status}`)
    // Trusted as is: checking the shape would be more hand-written code.
    response = await res.json()
  } catch (e) {
    throw new UpstreamError(`DNS lookup of ${input.name} ${input.type} failed: ${e instanceof Error ? e.message : e}`)
  }
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

async function run(q: URLSearchParams) {
  const parsed = parse(q)
  if ("error" in parsed) return { status: 400, error: parsed.error }
  try {
    return { status: 200, result: await lookup(parsed.input) }
  } catch (e) {
    if (e instanceof UpstreamError) return { status: 502, error: e.message }
    console.error(e)
    return { status: 500, error: "Internal error" }
  }
}

// HTML by template string; every value goes through escape().
const page = (q: URLSearchParams, outcome?: Awaited<ReturnType<typeof run>>) => `<!doctype html>
<h1>DNS lookup</h1>
<form method="get">
  <input name="name" value="${escape(q.get("name") ?? "")}" placeholder="example.com">
  <select name="type">${RECORD_TYPES.map((t) => `<option${t === (q.get("type") ?? "A").toUpperCase() ? " selected" : ""}>${t}</option>`).join("")}</select>
  <button>Run</button>
</form>
${outcome && "error" in outcome ? `<p>Error: ${escape(String(outcome.error))}</p>` : ""}
${outcome && "result" in outcome ? `<table>${outcome.result!.records.map((r) => `<tr><td>${escape(r.value)}</td><td>${r.ttl}</td></tr>`).join("")}</table>` : ""}`

Deno.serve(async (req) => {
  const url = new URL(req.url)
  if (url.pathname === "/dns-lookup/api") {
    const outcome = await run(url.searchParams)
    return Response.json("result" in outcome ? outcome.result : { error: outcome.error }, { status: outcome.status })
  }
  if (url.pathname === "/dns-lookup") {
    const outcome = url.search ? await run(url.searchParams) : undefined
    return new Response(page(url.searchParams, outcome), { status: outcome?.status ?? 200, headers: { "content-type": "text/html; charset=utf-8" } })
  }
  return new Response("Not found", { status: 404 })
})
