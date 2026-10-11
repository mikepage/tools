// DMARC validator: a domain's _dmarc TXT record, checked for common mistakes,
// with every tag explained.

import { Effect, Schema, SchemaTransformation } from "effect"
import { Field, type Level, Select, Status, Summary, Table } from "../app/ui.tsx"
import * as Doh from "../lib/doh.ts"
import { cleanDomain, Domain } from "../lib/domain.ts"
import * as Tool from "./Tool.ts"

// --- Input ----------------------------------------------------------------------

const blank = (s: string | undefined) => (s === undefined || s.trim() === "" ? undefined : s)

/** People paste `_dmarc.example.com`; the tool adds the prefix itself. */
export const stripDmarc = (input: string): string => {
  const d = cleanDomain(input)
  return d.startsWith("_dmarc.") ? d.slice("_dmarc.".length) : d
}

const Params = Schema.Struct({
  domain: Schema.optional(Schema.String),
  resolver: Schema.optional(Schema.String),
}).pipe(
  Schema.decodeTo(
    Schema.Struct({ domain: Domain, resolver: Doh.ResolverParam }),
    SchemaTransformation.transform({
      decode: (q) => ({
        domain: stripDmarc(blank(q.domain) ?? ""),
        resolver: blank(q.resolver) ?? "cloudflare",
      }),
      encode: (i) => i,
    }),
  ),
)
type Input = typeof Params.Type

// --- Result ---------------------------------------------------------------------

export type Policy = "none" | "quarantine" | "reject"

export interface Check {
  readonly level: Level
  readonly text: string
}

export interface Tag {
  readonly tag: string
  readonly value: string
  readonly description: string
}

export interface DmarcRecord {
  readonly record: string
  readonly checks: ReadonlyArray<Check>
  readonly tags: ReadonlyArray<Tag>
}

export interface Result {
  readonly domain: string
  readonly resolver: Doh.Resolver
  readonly records: ReadonlyArray<DmarcRecord>
  /** The policy of the first record; a record without p= counts as none. Null without a record. */
  readonly policy: string | null
  readonly policyDescription: string | null
  readonly queryTime: number
  /** The DNS RCODE of the _dmarc query. */
  readonly status: number
  /** Set when the resolver or nameserver failed (not for NXDOMAIN, which only means no record). */
  readonly dnsError: string | null
}

// --- Parsing and checks (no DNS) ---------------------------------------------------

const POLICIES: ReadonlyArray<string> = ["none", "quarantine", "reject"]

/** `v=DMARC1; p=reject` -> tag/value pairs, tags lowercased, in record order. */
export const splitTags = (record: string): ReadonlyArray<readonly [string, string]> =>
  record.split(";").map((p) => p.trim()).filter(Boolean).map((part) => {
    const [k = "", ...rest] = part.split("=")
    return [k.trim().toLowerCase(), rest.join("=").trim()] as const
  })

export const validateDmarc = (record: string): ReadonlyArray<Check> => {
  const checks: Array<Check> = []
  const tags = new Map(splitTags(record))
  const lower = (tag: string) => tags.get(tag)?.toLowerCase()

  if (!/^v\s*=\s*dmarc1\s*(;|$)/i.test(record.trim())) checks.push({ level: "bad", text: "Record must start with v=DMARC1." })
  else checks.push({ level: "ok", text: "v=DMARC1 present and first." })

  const p = lower("p")
  if (p === undefined) checks.push({ level: "bad", text: "Required tag p= is missing. Receivers treat this as p=none." })
  else if (!POLICIES.includes(p)) checks.push({ level: "bad", text: `Invalid policy p=${tags.get("p")}.` })
  else if (p === "none") {
    checks.push({
      level: "warn",
      text: "p=none is monitoring only: spoofed mail is still delivered. Move to quarantine or reject once reports look clean.",
    })
  } else checks.push({ level: "ok", text: `Enforcing policy: p=${p}.` })

  const rua = tags.get("rua")
  if (!rua) checks.push({ level: "warn", text: "No rua= address, so you get no reports on who sends mail as this domain." })
  else checks.push({ level: "ok", text: `Aggregate reports go to ${rua}.` })

  const pct = tags.get("pct")
  if (pct !== undefined && pct !== "100") checks.push({ level: "warn", text: `pct=${pct}: the policy applies to only ${pct}% of mail.` })

  const sp = lower("sp")
  if (sp !== undefined && !POLICIES.includes(sp)) checks.push({ level: "bad", text: `Invalid subdomain policy sp=${tags.get("sp")}.` })
  if (sp === "none" && p !== "none") checks.push({ level: "warn", text: "sp=none weakens the policy for all subdomains." })

  for (const t of ["adkim", "aspf"]) {
    const v = lower(t)
    if (v !== undefined && v !== "r" && v !== "s") checks.push({ level: "bad", text: `Invalid ${t}=${tags.get(t)} (must be r or s).` })
  }
  return checks
}

const POLICY_TEXT: Record<string, string> = {
  none: "No action on failing mail (monitoring only)",
  quarantine: "Failing mail is treated as suspicious, usually sent to spam",
  reject: "Failing mail is rejected outright",
}

const FAILURE_OPTIONS: Record<string, string> = {
  "0": "report when all mechanisms fail",
  "1": "report when any mechanism fails",
  d: "report on DKIM failure",
  s: "report on SPF failure",
}

const alignment = (kind: string, v: string) =>
  v.toLowerCase() === "s" ? `${kind} alignment: strict (exact domain match)` : `${kind} alignment: relaxed (organizational domain match)`

const TAG_DESCRIPTIONS: Record<string, (v: string) => string> = {
  v: (v) => `DMARC version: ${v}`,
  p: (v) => POLICY_TEXT[v.toLowerCase()] ?? `Unknown policy: ${v}`,
  sp: (v) => `Subdomains: ${POLICY_TEXT[v.toLowerCase()]?.toLowerCase() ?? v}`,
  rua: (v) => `Aggregate reports sent to ${v}`,
  ruf: (v) => `Forensic reports sent to ${v}`,
  pct: (v) => `Policy applies to ${v}% of failing mail`,
  adkim: (v) => alignment("DKIM", v),
  aspf: (v) => alignment("SPF", v),
  fo: (v) => `Failure reports: ${v.split(":").map((o) => FAILURE_OPTIONS[o.trim().toLowerCase()] ?? o).join(", ")}`,
  rf: (v) => `Report format: ${v}`,
  ri: (v) => {
    const s = parseInt(v, 10)
    return Number.isNaN(s) ? `Report interval: ${v}` : `Report interval: ${s} seconds (${Math.round(s / 3600)} hours)`
  },
}

export const parseTags = (record: string): ReadonlyArray<Tag> =>
  splitTags(record).map(([tag, value]) => ({ tag, value, description: TAG_DESCRIPTIONS[tag]?.(value) ?? `Unknown tag ${tag}` }))

export const policyDescription = (policy: string): string => {
  switch (policy) {
    case "reject":
      return "This domain has a strict DMARC policy. Receivers reject mail that fails DMARC. This is the strongest protection against spoofing."
    case "quarantine":
      return "This domain has a moderate DMARC policy. Receivers treat mail that fails DMARC as suspicious and usually put it in spam."
    case "none":
      return "This domain has a monitoring-only DMARC policy. Mail that fails DMARC is still delivered, so it gives no protection against spoofing."
    default:
      return "Unknown policy. Receivers ignore a record with an invalid policy."
  }
}

// --- The tool -------------------------------------------------------------------

export const checkDmarc = Effect.fnUntraced(function*(input: Input) {
  const { response, ms } = yield* Doh.query(`_dmarc.${input.domain}`, "TXT", { resolver: input.resolver })
  // NXDOMAIN on _dmarc only means there is no record; anything else is a DNS problem.
  const dnsError = response.Status !== 0 && response.Status !== 3
    ? Doh.DNS_STATUS[response.Status] ?? `DNS error ${response.Status}`
    : null
  const found = Doh.answersOf(response, 16).map((a) => Doh.unquoteTxt(a.data)).filter((r) => /^v\s*=\s*dmarc/i.test(r))
  // RFC 7489 §6.6.3: with more than one record, receivers apply none of them.
  const multiple: ReadonlyArray<Check> = found.length > 1
    ? [{ level: "bad", text: `${found.length} DMARC records published. Receivers ignore all of them; keep exactly one.` }]
    : []
  const records = found.map((record) => ({ record, checks: [...multiple, ...validateDmarc(record)], tags: parseTags(record) }))
  const policy = records[0] ? (records[0].tags.find((t) => t.tag === "p")?.value.toLowerCase() || "none") : null
  return {
    domain: input.domain,
    resolver: input.resolver,
    records,
    policy,
    policyDescription: policy ? policyDescription(policy) : null,
    queryTime: ms,
    status: response.Status,
    dnsError,
  } satisfies Result
})

// --- Views ----------------------------------------------------------------------

const Form = ({ query }: { readonly query: Tool.Query }) => (
  <>
    <Field label="Domain" name="domain" value={query["domain"]} placeholder="example.com" grow autofocus />
    <Select
      label="Resolver"
      name="resolver"
      value={query["resolver"] ?? "cloudflare"}
      options={Doh.RESOLVER_NAMES.map((r) => [r, Doh.RESOLVERS[r].label])}
    />
  </>
)

const policyLevel = (policy: string): Level => (policy === "reject" || policy === "quarantine" ? "ok" : policy === "none" ? "warn" : "bad")

/** The verdict in one line: what happens to spoofed mail. */
const Verdict = ({ result }: { readonly result: Result }) => {
  if (result.dnsError) return <p><Status level="bad">DNS lookup failed: {result.dnsError}.</Status></p>
  if (result.policy === null) {
    return (
      <p>
        <Status level="bad">
          No DMARC record at <code>_dmarc.{result.domain}</code>. Anyone can send mail as this domain unnoticed.
        </Status>
      </p>
    )
  }
  return <p><Status level={policyLevel(result.policy)}>{result.policyDescription}</Status></p>
}

const Record = ({ record }: { readonly record: DmarcRecord }) => (
  <>
    <pre class="block">{record.record}</pre>
    <h3>Checks</h3>
    <ul class="plain">
      {record.checks.map((c) => <li><Status level={c.level}>{c.text}</Status></li>)}
    </ul>
    <h3>Tags</h3>
    <Table head={["Tag", "Value", "Meaning"]} rows={record.tags.map((t) => [<code>{t.tag}</code>, <code>{t.value}</code>, t.description])} />
  </>
)

const Result = ({ result }: { readonly result: Result }) => (
  <>
    <Summary
      items={[
        ["Policy", result.policy ?? "none published"],
        ["Records", result.records.length],
        ["Resolver", Doh.RESOLVERS[result.resolver].label],
        ["Time", `${result.queryTime} ms`],
      ]}
    />
    <Verdict result={result} />
    {result.records.map((r) => <Record record={r} />)}
  </>
)

export const dmarcValidator = Tool.make<Input, Result>({
  slug: "dmarc-validator",
  title: "DMARC validator",
  summary: "Fetch a domain's DMARC record, explain every tag and flag common mistakes.",
  category: "Email",
  params: Params,
  run: checkDmarc,
  Form,
  Result,
  examples: [
    { label: "google.com", query: "domain=google.com" },
    { label: "cloudflare.com", query: "domain=cloudflare.com" },
    { label: "github.com", query: "domain=github.com" },
  ],
})
