// DNS discovery: a domain's apex records, email-authentication and Microsoft
// 365 setup, and its subdomains, from about a hundred DNS-over-HTTPS probes
// run twenty at a time. Names on certificates in Certificate Transparency
// logs (crt.sh) are probed too; that lookup is cached for an hour and
// degrades to a note when crt.sh is down.

import { Array as Arr, DateTime, Duration, Effect, Order, Schedule, Schema, SchemaTransformation } from "effect"
import { HttpClient } from "effect/http"
import { Check, Field, type Level, Select, Status, Summary, Table } from "../app/ui.tsx"
import * as Doh from "../lib/doh.ts"
import { Domain } from "../lib/domain.ts"
import * as Tool from "./Tool.ts"

// --- What gets probed -----------------------------------------------------------

// Every probe is one DoH query. CNAMEs are not queried on their own: resolvers
// return the CNAME chain in the answer to A/AAAA/TXT, even when it dangles.
export const APEX_TYPES = ["A", "AAAA", "NS", "MX", "SOA", "TXT", "CAA"]
export const SUBDOMAINS = ["www", "mail", "smtp", "imap", "pop", "webmail", "autodiscover", "autoconfig", "ftp", "vpn", "remote", "api", "cdn", "blog", "shop", "dev", "staging", "test", "ns1", "ns2", "m", "app", "lyncdiscover", "sip"]
// Microsoft 365 device registration names are CNAME-only; one A query surfaces the chain.
const CNAME_ONLY = ["enterpriseregistration", "enterpriseenrollment"]
export const DKIM_SELECTORS = ["api", "cf2024-1", "cm", "default", "dk", "dkim", "google", "k1", "k2", "k3", "krs", "m1", "mail", "mailjet", "mailo", "mailru", "mandrill", "ml", "mx", "pic", "resend", "s1", "s2", "selector1", "selector2", "smtpapi", "smtp", "titan1", "transip-a", "transip-b", "transip-c", "x", "zmail", "zoho"]
const EMAIL_TXT = ["_dmarc", "_mta-sts", "_smtp._tls", "_domainkey", "_dkim", "x-transip-mail-auth"]
const SRV = ["_autodiscover._tcp", "_sipfederationtls._tcp", "_sip._tls"]
const WILDCARD_TYPES = ["A", "AAAA", "TXT", "CAA"]
// Names from CT logs cost two queries each; cap them to keep a scan inside
// the Workers subrequest limit.
const CT_MAX = 50
const CONCURRENCY = 20

export type Group = "apex" | "email" | "subdomains"

interface Probe {
  /** Relative label: `@`, `www`, `selector1._domainkey`. */
  readonly label: string
  readonly type: string
  readonly group: Group
}

const staticProbes = (): Array<Probe> => [
  ...APEX_TYPES.map((type) => ({ label: "@", type, group: "apex" as const })),
  ...EMAIL_TXT.map((label) => ({ label, type: "TXT", group: "email" as const })),
  ...DKIM_SELECTORS.map((s) => ({ label: `${s}._domainkey`, type: "TXT", group: "email" as const })),
  ...SRV.map((label) => ({ label, type: "SRV", group: "email" as const })),
  ...SUBDOMAINS.flatMap((label) => ["A", "AAAA"].map((type) => ({ label, type, group: "subdomains" as const }))),
  ...CNAME_ONLY.map((label) => ({ label, type: "A", group: "subdomains" as const })),
]

// --- Input ----------------------------------------------------------------------

const blank = (s: string | undefined) => (s === undefined || s.trim() === "" ? undefined : s)
const isOn = (s: string) => /^(1|true|on|yes)$/i.test(s)

// `name` is accepted as an alias for `domain`. DNSSEC is off unless asked
// for; CT is on unless switched off. The form's checkboxes send `on`/`off`.
const Params = Schema.Struct({
  domain: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  resolver: Schema.optional(Schema.String),
  dnssec: Schema.optional(Schema.String),
  ct: Schema.optional(Schema.String),
}).pipe(
  Schema.decodeTo(
    Schema.Struct({ domain: Domain, resolver: Doh.ResolverParam, dnssec: Schema.Boolean, ct: Schema.Boolean }),
    SchemaTransformation.transform({
      decode: (q) => ({
        domain: blank(q.domain) ?? blank(q.name) ?? "",
        resolver: blank(q.resolver) ?? "cloudflare",
        dnssec: isOn(blank(q.dnssec) ?? "0"),
        ct: isOn(blank(q.ct) ?? "1"),
      }),
      encode: (i) => ({ domain: i.domain, resolver: i.resolver, dnssec: i.dnssec ? "1" : "0", ct: i.ct ? "1" : "0" }),
    }),
  ),
)
type Input = typeof Params.Type

// --- Result ---------------------------------------------------------------------

export interface Row {
  /** Relative label: `@`, `www`. */
  readonly name: string
  readonly type: string
  readonly ttl: number
  /** Display value: no trailing dots, TXT unquoted. */
  readonly value: string
  /** RFC 1035 presentation value: absolute names with trailing dots, TXT quoted. */
  readonly zone: string
}

export interface Wildcard {
  readonly cname: string | null
  readonly targets: ReadonlyArray<string>
}

export interface Result {
  readonly domain: string
  readonly resolver: Doh.Resolver
  readonly scannedAt: string
  readonly queryTimeMs: number
  /** DoH queries made, plus one when crt.sh was fetched. */
  readonly subrequests: number
  readonly total: number
  readonly dnssec: { readonly validated: boolean } | null
  readonly wildcard: Wildcard | null
  readonly ct: {
    readonly discovered: number
    readonly probed: number
    readonly activeCerts: number
    readonly totalCerts: number
    readonly cached: boolean
    readonly error?: string
  } | null
  readonly apex: ReadonlyArray<Row>
  readonly email: ReadonlyArray<Row>
  readonly subdomains: ReadonlyArray<Row>
}

// --- Record formatting ----------------------------------------------------------

const TYPE_NAMES: Readonly<Record<number, string>> = { 1: "A", 2: "NS", 5: "CNAME", 6: "SOA", 15: "MX", 16: "TXT", 28: "AAAA", 33: "SRV", 257: "CAA" }
const typeName = (n: number): string => TYPE_NAMES[n] ?? String(n)

const dot = (s: string): string => (s.endsWith(".") ? s : `${s}.`)

// Quote TXT for a zone file: keep resolver-quoted strings, else split into
// quoted chunks of at most 255 characters.
const zoneTxt = (data: string): string =>
  data.startsWith('"')
    ? data
    : (data.match(/[\s\S]{1,255}/g) ?? [""]).map((c) => `"${c.replace(/(["\\])/g, "\\$1")}"`).join(" ")

/** One answer's data as a display value and as a zone-file value. */
export const formatValue = (type: string, data: string): { value: string; zone: string } => {
  const p = data.trim().split(/\s+/)
  switch (type) {
    case "CNAME":
    case "NS":
      return { value: Doh.noDot(data), zone: dot(data) }
    case "MX":
      return { value: `${p[0]} ${Doh.noDot(p[1] ?? "")}`, zone: `${p[0]} ${dot(p[1] ?? "")}` }
    case "SRV":
      return { value: `${p[0]} ${p[1]} ${p[2]} ${Doh.noDot(p[3] ?? "")}`, zone: `${p[0]} ${p[1]} ${p[2]} ${dot(p[3] ?? "")}` }
    case "SOA": {
      const rest = p.slice(2).join(" ")
      return { value: `${Doh.noDot(p[0] ?? "")} ${Doh.noDot(p[1] ?? "")} ${rest}`, zone: `${dot(p[0] ?? "")} ${dot(p[1] ?? "")} ${rest}` }
    }
    case "TXT":
      return { value: Doh.unquoteTxt(data), zone: zoneTxt(data) }
    default:
      return { value: data, zone: data }
  }
}

// --- One probe ------------------------------------------------------------------

interface Answered {
  readonly probe: Probe
  readonly rows: ReadonlyArray<Row>
  readonly ad: boolean
}

// One probe -> the records at exactly that name: the queried type, or the
// CNAME the name aliases. A probe that fails just finds nothing: one bad name
// must not sink a scan of a hundred.
const runProbe = (domain: string, probe: Probe, input: Input) => {
  const fqdn = probe.label === "@" ? domain : `${probe.label}.${domain}`
  return Doh.query(fqdn, probe.type, { resolver: input.resolver, dnssec: input.dnssec }).pipe(
    Effect.map(({ response }): Answered => ({
      probe,
      rows: (response.Answer ?? [])
        .filter((a) => Doh.noDot(a.name).toLowerCase() === fqdn && (typeName(a.type) === probe.type || a.type === 5))
        .map((a) => ({ name: probe.label, type: typeName(a.type), ttl: a.TTL, ...formatValue(typeName(a.type), a.data) })),
      ad: response.AD === true,
    })),
    Effect.orElseSucceed((): Answered => ({ probe, rows: [], ad: false })),
  )
}

// --- Wildcards ------------------------------------------------------------------

// Resolve a random label: anything that answers is a wildcard, and its values
// mark false positives among the other probes.
const detectWildcard = Effect.fnUntraced(function*(input: Input) {
  const label = `wc-probe-${(yield* Effect.sync(() => crypto.randomUUID())).slice(0, 12)}`
  const answers = yield* Effect.forEach(
    WILDCARD_TYPES,
    (type) => runProbe(input.domain, { label, type, group: "subdomains" }, input),
    { concurrency: "unbounded" },
  )
  const rows = answers.flatMap((a) => a.rows)
  if (rows.length === 0) return null
  return {
    cname: rows.find((r) => r.type === "CNAME")?.value ?? null,
    targets: Arr.dedupe(rows.map((r) => r.value)),
  } satisfies Wildcard
})

// --- Certificate Transparency (crt.sh) ------------------------------------------

const CrtShEntries = Schema.Array(Schema.Struct({ name_value: Schema.String, not_after: Schema.String }))
type CrtShEntry = (typeof CrtShEntries.Type)[number]

// What gets cached: the parsed summary, not crt.sh's (often huge) response.
const CtSummary = Schema.Struct({
  subdomains: Schema.Array(Schema.String),
  totalCerts: Schema.Number,
  activeCerts: Schema.Number,
})
type CtSummary = typeof CtSummary.Type

class CrtShError extends Schema.TaggedError<CrtShError>()("CrtShError", {
  message: Schema.String,
  /** Set when crt.sh answered with a 5xx: worth one retry. */
  status: Schema.optional(Schema.Number),
  cause: Schema.optional(Schema.Defect()),
}) {}

/** Unexpired certificates -> unique subdomain labels (no wildcards, no apex, nothing off-domain). */
export const subdomainsFromCerts = (
  domain: string,
  entries: ReadonlyArray<CrtShEntry>,
  now: number,
): { subdomains: Array<string>; activeCerts: number } => {
  // crt.sh gives not_after in UTC without a zone suffix.
  const active = entries.filter((e) =>
    Date.parse(/Z$|[+-]\d\d:?\d\d$/.test(e.not_after) ? e.not_after : `${e.not_after}Z`) > now
  )
  const found = new Set<string>()
  for (const e of active) {
    for (const raw of e.name_value.split("\n")) {
      const name = raw.trim().toLowerCase().replace(/\.$/, "")
      if (!name || name.startsWith("*") || !name.endsWith(`.${domain}`)) continue
      const sub = name.slice(0, -(domain.length + 1))
      if (/^[a-z0-9_]([a-z0-9_.-]*[a-z0-9])?$/.test(sub)) found.add(sub)
    }
  }
  return { subdomains: Arr.sort([...found], Order.String), activeCerts: active.length }
}

const CRTSH_TIMEOUT = Duration.seconds(10)

// crt.sh is slow and sheds load with 502/503s: a timeout per attempt, and one
// retry on a 5xx (not on a timeout: that would double the wait).
const fetchCtSummary = Effect.fnUntraced(function*(domain: string) {
  const client = yield* HttpClient.HttpClient
  const response = yield* client.get("https://crt.sh/", {
    urlParams: { q: `%.${domain}`, output: "json" },
    headers: { "user-agent": "tools.mikepage.nl dns-discovery" },
  }).pipe(
    Effect.timeout(CRTSH_TIMEOUT),
    Effect.mapError((cause) =>
      new CrtShError({
        message: cause._tag === "TimeoutError" ? `crt.sh did not answer within ${Duration.toSeconds(CRTSH_TIMEOUT)}s` : "crt.sh could not be reached",
        cause,
      })
    ),
    Effect.filterOrFail(
      (r) => r.status < 500,
      (r) => new CrtShError({ message: `crt.sh answered HTTP ${r.status}`, status: r.status }),
    ),
    Effect.retry({ times: 1, while: (e) => e.status !== undefined, schedule: Schedule.spaced("200 millis") }),
  )
  if (response.status !== 200) return yield* new CrtShError({ message: `crt.sh answered HTTP ${response.status}` })
  const text = yield* response.text.pipe(
    Effect.timeout(CRTSH_TIMEOUT),
    Effect.mapError((cause) => new CrtShError({ message: "crt.sh response could not be read", cause })),
  )
  const entries = text.trim() === "" ? [] : yield* Schema.decodeUnknownEffect(Schema.fromJsonString(CrtShEntries))(text).pipe(
    Effect.mapError((cause) => new CrtShError({ message: "crt.sh returned an unreadable response", cause })),
  )
  const now = DateTime.toEpochMillis(yield* DateTime.now)
  return { ...subdomainsFromCerts(domain, entries, now), totalCerts: entries.length } satisfies CtSummary
})

// The Workers Cache API, when there is one (not in Node tests). The key is
// synthetic: it is never fetched, only used to address the entry. Any cache
// trouble just means a miss.
const cache = (): Cache | undefined => (typeof caches === "undefined" ? undefined : (caches as unknown as { default: Cache }).default)
const cacheKey = (domain: string) => new Request(`https://crtsh.cache.tools.invalid/v1/${encodeURIComponent(domain)}`)

const cacheGet = (domain: string) =>
  Effect.gen(function*() {
    const store = cache()
    if (!store) return undefined
    const hit = yield* Effect.tryPromise(() => store.match(cacheKey(domain)))
    if (!hit) return undefined
    return yield* Effect.tryPromise(() => hit.json()).pipe(Effect.flatMap(Schema.decodeUnknownEffect(CtSummary)))
  }).pipe(Effect.orElseSucceed(() => undefined))

const cachePut = (domain: string, summary: CtSummary) =>
  Effect.gen(function*() {
    const store = cache()
    if (!store) return
    const response = Response.json(summary, { headers: { "cache-control": "public, max-age=3600" } })
    yield* Effect.tryPromise(() => store.put(cacheKey(domain), response))
  }).pipe(Effect.ignore)

interface CtResult extends CtSummary {
  readonly cached: boolean
  readonly error?: string
}

// Failures never reach the client as errors: they come back in `error`.
const ctSubdomains = (domain: string): Effect.Effect<CtResult, never, HttpClient.HttpClient> =>
  Effect.gen(function*() {
    const hit = yield* cacheGet(domain)
    if (hit) return { ...hit, cached: true }
    const summary = yield* fetchCtSummary(domain)
    yield* cachePut(domain, summary)
    return { ...summary, cached: false }
  }).pipe(
    Effect.catchTag("CrtShError", (e) =>
      Effect.succeed<CtResult>({ subdomains: [], totalCerts: 0, activeCerts: 0, cached: false, error: e.message })),
  )

// --- The scan -------------------------------------------------------------------

const byNameThenType: Order.Order<Row> = Order.combine(
  Order.mapInput(Order.String, (r: Row) => r.name),
  Order.mapInput(Order.String, (r: Row) => r.type),
)

export const discover = Effect.fnUntraced(function*(input: Input) {
  const { domain } = input
  const scannedAt = DateTime.formatIso(yield* DateTime.now)
  // crt.sh first (it feeds the probe list), with wildcard detection alongside.
  const [elapsed, { answered, probes, fromCt, wildcard, ctData }] = yield* Effect.timed(Effect.gen(function*() {
    const [ctData, wildcard] = yield* Effect.all(
      [input.ct ? ctSubdomains(domain) : Effect.succeed(null), detectWildcard(input)],
      { concurrency: "unbounded" },
    )
    const probes = staticProbes()
    const known = new Set(probes.map((p) => p.label))
    const fromCt = (ctData?.subdomains ?? []).filter((s) => !known.has(s))
    for (const label of fromCt.slice(0, CT_MAX)) {
      probes.push({ label, type: "A", group: "subdomains" }, { label, type: "AAAA", group: "subdomains" })
    }
    // The fan-out: every probe, at most CONCURRENCY in flight.
    const answered = yield* Effect.forEach(probes, (p) => runProbe(domain, p, input), { concurrency: CONCURRENCY })
    return { answered, probes, fromCt, wildcard, ctData }
  }))

  // Values the random label also resolves to only exist because of the
  // wildcard. Duplicate rows (a CNAME seen from both the A and AAAA probe)
  // are kept once.
  const targets = new Set(wildcard?.targets ?? [])
  const groups: Record<Group, Array<Row>> = { apex: [], email: [], subdomains: [] }
  const seen = new Set<string>()
  for (const { probe, rows } of answered) {
    for (const r of rows) {
      if (probe.label !== "@" && targets.has(r.value)) continue
      const key = `${r.name}|${r.type}|${r.zone}`
      if (seen.has(key)) continue
      seen.add(key)
      groups[probe.group].push(r)
    }
  }
  groups.subdomains = Arr.sort(groups.subdomains, byNameThenType)

  const fetchedCrt = ctData != null && !ctData.cached && ctData.error === undefined
  return {
    domain,
    resolver: input.resolver,
    scannedAt,
    queryTimeMs: Math.round(Duration.toMillis(elapsed)),
    subrequests: probes.length + WILDCARD_TYPES.length + (fetchedCrt ? 1 : 0),
    total: groups.apex.length + groups.email.length + groups.subdomains.length,
    dnssec: input.dnssec ? { validated: answered.some((a) => a.ad) } : null,
    wildcard,
    ct: ctData && {
      discovered: fromCt.length,
      probed: Math.min(fromCt.length, CT_MAX),
      activeCerts: ctData.activeCerts,
      totalCerts: ctData.totalCerts,
      cached: ctData.cached,
      ...(ctData.error === undefined ? {} : { error: ctData.error }),
    },
    ...groups,
  } satisfies Result
})

// --- Reading the result ---------------------------------------------------------

export interface Finding {
  readonly level: Level
  readonly label: string
  readonly detail: string
}

const txtAt = (r: Result, name: string, prefix: RegExp) =>
  [...r.apex, ...r.email].filter((row) => row.name === name && row.type === "TXT" && prefix.test(row.value))

/** The email setup at a glance: SPF, DMARC, DKIM, MTA-STS, TLS reporting, Microsoft 365. */
export const emailSetup = (r: Result): ReadonlyArray<Finding> => {
  const mx = r.apex.filter((row) => row.type === "MX")
  const spf = txtAt(r, "@", /^v=spf1\b/i)
  const dmarc = txtAt(r, "_dmarc", /^v=DMARC1\b/i)
  const policy = /\bp=(\w+)/i.exec(dmarc[0]?.value ?? "")?.[1]?.toLowerCase()
  const dkim = Arr.dedupe(
    r.email.filter((row) => row.name.endsWith("._domainkey") && (row.type === "CNAME" || /\bp=/.test(row.value)))
      .map((row) => row.name.replace(/\._domainkey$/, "")),
  )
  const mtaSts = txtAt(r, "_mta-sts", /^v=STSv1\b/i)
  const tlsRpt = txtAt(r, "_smtp._tls", /^v=TLSRPTv1\b/i)
  const m365 = [...r.apex, ...r.subdomains].some((row) => /\.(outlook|protection\.outlook|office365)\.com$|\.mail\.protection\.outlook\.com$/i.test(row.value))
  return [
    mx.length > 0
      ? { level: "ok", label: "MX", detail: `${mx.length} mail server${mx.length > 1 ? "s" : ""}` }
      : { level: "warn", label: "MX", detail: "none: this domain does not receive mail" },
    spf.length === 1
      ? { level: "ok", label: "SPF", detail: "published" }
      : spf.length > 1
      ? { level: "bad", label: "SPF", detail: `${spf.length} records; there must be one` }
      : { level: "bad", label: "SPF", detail: "missing" },
    dmarc.length === 0
      ? { level: "bad", label: "DMARC", detail: "missing" }
      : policy === "reject" || policy === "quarantine"
      ? { level: "ok", label: "DMARC", detail: `p=${policy}` }
      : { level: "warn", label: "DMARC", detail: `p=${policy ?? "?"}: monitoring only` },
    dkim.length > 0
      ? { level: "ok", label: "DKIM", detail: `selector${dkim.length > 1 ? "s" : ""} ${dkim.join(", ")}` }
      : { level: "warn", label: "DKIM", detail: "no common selector found (others may exist)" },
    mtaSts.length > 0
      ? { level: "ok", label: "MTA-STS", detail: "published" }
      : { level: "warn", label: "MTA-STS", detail: "not published" },
    tlsRpt.length > 0
      ? { level: "ok", label: "TLS-RPT", detail: "published" }
      : { level: "warn", label: "TLS-RPT", detail: "not published" },
    ...(m365 ? [{ level: "ok" as const, label: "Microsoft 365", detail: "in use" }] : []),
  ]
}

/** The scan as a zone file. Not a zone transfer: only names that were probed. */
export const zoneFile = (r: Result): string => {
  const lines = [
    `; Zone file for ${r.domain}`,
    `; Exported by tools dns-discovery on ${r.scannedAt}`,
    `; Resolver: ${Doh.RESOLVERS[r.resolver].label}`,
    `; DNSSEC: ${r.dnssec ? (r.dnssec.validated ? "validated (AD bit set)" : "not validated") : "not requested"}`,
    ...(r.wildcard ? [`; Wildcard detected (*.${r.domain}); matching records filtered`] : []),
    "; Discovered by probing common names, not a complete zone transfer",
    ";",
    `$ORIGIN ${r.domain}.`,
    "",
  ]
  for (const row of [...r.apex, ...r.email, ...r.subdomains]) lines.push(`${row.name}\t${row.ttl}\tIN\t${row.type}\t${row.zone}`)
  return lines.join("\n") + "\n"
}

// --- Views ----------------------------------------------------------------------

const flag = (value: string | undefined, fallback: boolean) => (value === undefined || value === "" ? fallback : isOn(value))

const Form = ({ query }: { readonly query: Tool.Query }) => (
  <>
    <Field label="Domain" name="domain" value={query["domain"] ?? query["name"]} placeholder="example.com" grow autofocus />
    <Select
      label="Resolver"
      name="resolver"
      value={query["resolver"] ?? "cloudflare"}
      options={Doh.RESOLVER_NAMES.map((r) => [r, Doh.RESOLVERS[r].label])}
    />
    <Check label="CT logs" name="ct" checked={flag(query["ct"], true)} />
    <Check label="DNSSEC" name="dnssec" checked={flag(query["dnssec"], false)} />
  </>
)

const ttl = (seconds: number) => (seconds >= 3600 ? `${Math.round(seconds / 360) / 10} h` : seconds >= 60 ? `${Math.round(seconds / 60)} min` : `${seconds} s`)

const Records = (props: { readonly rows: ReadonlyArray<Row>; readonly empty: string; readonly nameColumn?: boolean }) =>
  props.rows.length === 0
    ? <p class="muted">{props.empty}</p>
    : (
      <Table
        head={props.nameColumn === false ? ["Type", "Value", "TTL"] : ["Name", "Type", "Value", "TTL"]}
        rows={props.rows.map((r) => [
          ...(props.nameColumn === false ? [] : [<code>{r.name}</code>]),
          r.type,
          <code>{r.value}</code>,
          ttl(r.ttl),
        ])}
      />
    )

const Result = ({ result }: { readonly result: Result }) => {
  const names = Arr.dedupe(result.subdomains.map((r) => r.name))
  return (
    <>
      <Summary
        items={[
          ["Records", result.total],
          ["Subdomains", names.length],
          ["Queries", result.subrequests],
          ["Time", `${(result.queryTimeMs / 1000).toFixed(1)} s`],
          ["Resolver", Doh.RESOLVERS[result.resolver].label],
          ...(result.dnssec ? [["DNSSEC", result.dnssec.validated ? "validated" : "not validated"] as const] : []),
        ]}
      />

      <h3>Email</h3>
      <ul class="plain">
        {emailSetup(result).map((f) => <li><Status level={f.level}>{f.label}</Status> <span class="muted">{f.detail}</span></li>)}
      </ul>

      {result.wildcard
        ? (
          <p class="notice">
            <Status level="warn">Wildcard</Status> Any name under <code>{result.domain}</code> resolves
            {result.wildcard.cname ? [" (to ", <code>{result.wildcard.cname}</code>, ")"] : null}. Matching records are left out.
          </p>
        )
        : null}

      <h3>Apex</h3>
      <Records rows={result.apex} empty="No apex records resolved." nameColumn={false} />

      <h3>Email authentication</h3>
      <Records rows={result.email} empty="No SPF, DMARC, DKIM, MTA-STS or SRV records found." />

      <h3>Subdomains</h3>
      <Records rows={result.subdomains} empty="None of the probed subdomains resolved." />
      <p class="muted">
        Probed {SUBDOMAINS.length} common names
        {result.ct === null
          ? ". Certificate Transparency was off."
          : result.ct.error
          ? `. Certificate Transparency skipped: ${result.ct.error}.`
          : `, plus ${result.ct.probed} of ${result.ct.discovered} new names from ${result.ct.activeCerts} unexpired certificates in CT logs${result.ct.cached ? " (cached)" : ""}.`}
      </p>

      <h3>Zone file</h3>
      <pre class="block">{zoneFile(result)}</pre>
      <p class="muted">A snapshot from probing common names, not a zone transfer: records under other names are not here.</p>
    </>
  )
}

export const dnsDiscovery = Tool.make<Input, Result>({
  slug: "dns-discovery",
  title: "DNS discovery",
  summary: "Scan a domain's apex records, email setup and subdomains in one go, with names from Certificate Transparency logs.",
  category: "DNS & domains",
  params: Params,
  run: discover,
  Form,
  Result,
  examples: [
    { label: "microsoft.com", query: "domain=microsoft.com&ct=off" },
    { label: "cloudflare.com with DNSSEC", query: "domain=cloudflare.com&dnssec=on" },
    { label: "github.io (wildcard)", query: "domain=github.io&ct=off" },
  ],
})
