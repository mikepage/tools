// SPF validator: a domain's SPF record, every include and redirect walked into
// a tree, DNS lookups counted against RFC 7208's limit of 10.

import type { Html } from "../jsx/jsx-runtime.ts"
import { Field, type Level, Select, Status, Summary } from "../app/ui.tsx"
import * as Doh from "../lib/doh.ts"
import { domainParam, isDomain } from "../lib/domain.ts"
import { since } from "../lib/http.ts"
import { oneOf, optional } from "../lib/params.ts"
import * as Tool from "./Tool.ts"

/** RFC 7208 §4.6.4: at most 10 DNS-querying terms per evaluation. */
export const MAX_LOOKUPS = 10
const TOO_MANY = "Too many DNS lookups"
const LOOKUP_MECHANISMS = new Set(["include", "a", "mx", "ptr", "exists"])

// --- Input ----------------------------------------------------------------------

export const MAX_RECORD_LENGTH = 4096

export interface Input {
  readonly domain: string
  readonly resolver: Doh.Resolver
  /** A draft to check instead of the published record. */
  readonly record: string | undefined
}

export const parse = (query: Tool.Query): Input => {
  const record = optional(query, "record")
  if (record !== undefined && record.length > MAX_RECORD_LENGTH) {
    throw new Tool.InputError(`record: at most ${MAX_RECORD_LENGTH} characters`)
  }
  return {
    domain: domainParam(query, ["domain"]),
    resolver: oneOf(query, "resolver", Doh.RESOLVER_NAMES, "cloudflare"),
    record,
  }
}

// --- Result ---------------------------------------------------------------------

export type Qualifier = "+" | "-" | "~" | "?"

export interface Issue {
  readonly level: Exclude<Level, "ok">
  readonly text: string
}

export interface Term {
  readonly raw: string
  readonly qualifier: Qualifier
  /** Mechanism or modifier name, lowercased. */
  readonly type: string
  readonly value: string
  /** true for `name=value` modifiers (redirect, exp, unknown ones). */
  readonly modifier: boolean
  /** The running lookup count this term brought the evaluation to, when it costs a lookup. */
  readonly lookup: number | null
  /** The record an include or redirect points at, when it was followed. */
  readonly child: Node | null
}

export interface Node {
  readonly domain: string
  readonly via: "root" | "include" | "redirect"
  readonly record: string | null
  readonly version: string | null
  /** Why this node has no record: DNS error, no SPF record, lookup limit, loop. */
  readonly note: string | null
  readonly terms: ReadonlyArray<Term>
  readonly issues: ReadonlyArray<Issue>
  readonly ms: number
}

export interface Result {
  readonly domain: string
  readonly resolver: Doh.Resolver
  /** true when `record` was supplied instead of looked up. */
  readonly draft: boolean
  readonly node: Node
  readonly lookups: number
  readonly maxLookups: number
  readonly queryTime: number
  /** Every issue in the tree, with the domain it belongs to. */
  readonly issues: ReadonlyArray<Issue & { readonly domain: string }>
}

// --- Parsing (no DNS) -------------------------------------------------------------

type ParsedTerm = Omit<Term, "lookup" | "child">

/** Splits one term into qualifier, name and value. */
export const parseTerm = (raw: string): ParsedTerm => {
  const modifier = raw.match(/^([a-z][a-z0-9_.-]*)=(.*)$/i)
  if (modifier) return { raw, qualifier: "+", type: modifier[1]!.toLowerCase(), value: modifier[2]!, modifier: true }
  const qualified = /^[+\-~?]/.test(raw)
  const qualifier = (qualified ? raw[0] : "+") as Qualifier
  const term = qualified ? raw.slice(1) : raw
  const m = term.match(/^([a-z][a-z0-9_.-]*)([:/].*)?$/i)
  if (!m) return { raw, qualifier, type: term.toLowerCase(), value: "", modifier: false }
  const rest = m[2] ?? ""
  return { raw, qualifier, type: m[1]!.toLowerCase(), value: rest.startsWith(":") ? rest.slice(1) : rest, modifier: false }
}

/** Parses a record and runs the checks that need no DNS. */
export const parseSpfRecord = (record: string) => {
  const issues: Array<Issue> = []
  const parts = record.trim().split(/\s+/).filter(Boolean)
  if (!parts[0] || !/^v=spf1$/i.test(parts[0])) {
    issues.push({ level: "bad", text: `Invalid version: expected "v=spf1", got "${parts[0] ?? ""}".` })
    return { version: null, terms: [] as ReadonlyArray<ParsedTerm>, issues }
  }
  const terms = parts.slice(1).map(parseTerm)
  const mechanisms = terms.filter((t) => !t.modifier)

  for (const t of terms) {
    if (t.type === "ptr") issues.push({ level: "warn", text: "\"ptr\" is deprecated and slow (RFC 7208 §5.5)." })
    if ((t.type === "include" || t.type === "redirect") && !t.value) {
      issues.push({ level: "bad", text: "Missing domain for include/redirect." })
    }
  }

  const all = mechanisms.find((t) => t.type === "all")
  if (all?.qualifier === "+") issues.push({ level: "bad", text: "\"+all\" allows the whole internet to send as you." })
  if (all?.qualifier === "?") issues.push({ level: "warn", text: "\"?all\" is neutral, so SPF effectively does nothing." })
  if (all && mechanisms.at(-1) !== all) {
    issues.push({ level: "warn", text: "\"all\" should be the last mechanism. Anything after it is never evaluated." })
  }

  const redirects = terms.filter((t) => t.type === "redirect")
  if (redirects.length > 1) issues.push({ level: "bad", text: "Multiple \"redirect\" modifiers. Only one is allowed (permerror)." })
  if (redirects.length > 0 && all) {
    issues.push({ level: "warn", text: "Both \"redirect\" and \"all\" present. \"redirect\" is ignored when \"all\" is present." })
  }
  if (!all && redirects.length === 0) issues.push({ level: "warn", text: "No \"all\" mechanism. Consider adding -all or ~all at the end." })

  if (record.length > 255) {
    issues.push({
      level: "warn",
      text: `Record is ${record.length} characters, over the 255-character TXT string limit. Split it into ${
        Math.ceil(record.length / 255)
      } strings.`,
    })
  }
  return { version: "spf1", terms, issues }
}

// --- The walk -------------------------------------------------------------------

type MutableNode = { -readonly [K in keyof Node]: Node[K] }

const emptyNode = (domain: string, via: Node["via"], note: string | null = null): MutableNode => ({
  domain,
  via,
  record: null,
  version: null,
  note,
  terms: [],
  issues: [],
  ms: 0,
})

interface Fetched {
  readonly ms: number
  readonly spf: ReadonlyArray<string>
  readonly note: string | null
}

/** The SPF records among a name's TXT records, or why there are none. */
const fetchSpf = async (domain: string, resolver: Doh.Resolver): Promise<Fetched> => {
  let answer: Awaited<ReturnType<typeof Doh.query>>
  try {
    answer = await Doh.query(domain, "TXT", { resolver })
  } catch (error) {
    // A failed lookup is a note on its node; the rest of the tree goes on.
    if (error instanceof Tool.UpstreamError) return { ms: 0, spf: [], note: error.message }
    throw error
  }
  const { response, ms } = answer
  if (response.Status !== 0) {
    return { ms, spf: [], note: `DNS lookup failed: ${Doh.DNS_STATUS[response.Status] ?? `DNS error ${response.Status}`}` }
  }
  const txt = Doh.answersOf(response, 16).map((a) => Doh.unquoteTxt(a.data))
  const spf = txt.filter((r) => /^v=spf1(\s|$)/i.test(r))
  const note = spf.length > 0 ? null : txt.length > 0 ? `No SPF record among ${txt.length} TXT records` : "No TXT records"
  return { ms, spf, note }
}

/** The running DNS lookup count of one evaluation. */
interface Counter {
  n: number
}

// Depth first and sequential: the lookup counter decides which term is the
// 11th, so the order of the queries matters.
const walk = async (
  domain: string,
  via: Node["via"],
  ancestors: ReadonlyArray<string>,
  lookups: Counter,
  resolver: Doh.Resolver,
  supplied?: string,
): Promise<Node> => {
  const node = emptyNode(domain, via)
  const issues: Array<Issue> = []

  let record: string
  if (supplied !== undefined) {
    record = supplied
  } else {
    const got = await fetchSpf(domain, resolver)
    node.ms = got.ms
    if (got.note !== null) return { ...node, note: got.note }
    if (got.spf.length > 1) issues.push({ level: "bad", text: `${got.spf.length} SPF records published: a permerror. Keep exactly one.` })
    record = got.spf[0]!
  }

  const parsed = parseSpfRecord(record)
  issues.push(...parsed.issues)
  const path = [...ancestors, domain]
  const hasAll = parsed.terms.some((t) => !t.modifier && t.type === "all")

  const follow = async (term: ParsedTerm, kind: "include" | "redirect"): Promise<Term> => {
    const target = term.value.toLowerCase().replace(/\.$/, "")
    if (!target) return { ...term, lookup: null, child: null } // reported by parseSpfRecord
    const lookup = ++lookups.n
    let child: Node
    if (!isDomain(target)) {
      child = emptyNode(target, kind, target.includes("%") ? "Contains SPF macros, not expanded" : "Not a valid domain name")
    } else if (path.includes(target)) {
      child = emptyNode(target, kind, "Already in this chain: include loop")
      issues.push({ level: "bad", text: `Include loop: ${target} includes itself.` })
    } else if (lookup > MAX_LOOKUPS) {
      child = emptyNode(target, kind, `DNS lookup limit exceeded (${MAX_LOOKUPS}), not followed`)
    } else {
      child = await walk(target, kind, path, lookups, resolver)
    }
    return { ...term, lookup, child }
  }

  const terms: Array<Term> = []
  for (const term of parsed.terms) {
    if (!term.modifier && term.type === "include") terms.push(await follow(term, "include"))
    else if (!term.modifier && LOOKUP_MECHANISMS.has(term.type)) terms.push({ ...term, lookup: ++lookups.n, child: null })
    else terms.push({ ...term, lookup: null, child: null })
  }
  // redirect= is applied after all mechanisms, and only without "all".
  const redirect = terms.findIndex((t) => t.type === "redirect" && t.modifier)
  if (redirect !== -1 && !hasAll) terms[redirect] = await follow(terms[redirect]!, "redirect")

  return { ...node, record, version: parsed.version, terms, issues }
}

const collectIssues = (node: Node, out: Array<Issue & { readonly domain: string }>): void => {
  if (node.note) out.push({ level: "bad", domain: node.domain, text: node.note })
  for (const i of node.issues) out.push({ ...i, domain: node.domain })
  for (const t of node.terms) if (t.child) collectIssues(t.child, out)
}

export const evaluateSpf = async (input: Input): Promise<Result> => {
  const lookups: Counter = { n: 0 }
  const start = performance.now()
  const node = await walk(input.domain, "root", [], lookups, input.resolver, input.record)
  const queryTime = since(start)
  const count = lookups.n
  const issues: Array<Issue & { readonly domain: string }> = []
  collectIssues(node, issues)
  if (count > MAX_LOOKUPS) {
    issues.push({
      level: "bad",
      domain: input.domain,
      text: `${TOO_MANY}: ${count} (RFC 7208 allows ${MAX_LOOKUPS}). Receivers return permerror; flatten your includes.`,
    })
  }
  return {
    domain: input.domain,
    resolver: input.resolver,
    draft: input.record !== undefined,
    node,
    lookups: count,
    maxLookups: MAX_LOOKUPS,
    queryTime,
    issues,
  }
}

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
    <Field label="Draft record (optional)" name="record" value={query["record"]} placeholder="v=spf1 include:_spf.example.com -all" grow />
  </>
)

const QUALIFIERS: Record<Qualifier, string> = { "+": "pass", "-": "fail", "~": "softfail", "?": "neutral" }

/** What a term does, in a few words. */
export const describeTerm = (t: Term): string => {
  const q = QUALIFIERS[t.qualifier]
  switch (t.type) {
    case "all":
      return `everything else: ${q}`
    case "ip4":
    case "ip6":
      return `${q} for ${t.value}`
    case "a":
      return `${q} for the A/AAAA addresses of ${t.value || "this domain"}`
    case "mx":
      return `${q} for the mail servers of ${t.value || "this domain"}`
    case "include":
      return `${q} if ${t.value} passes`
    case "exists":
      return `${q} if ${t.value} resolves`
    case "ptr":
      return `${q} by reverse DNS (deprecated)`
    case "redirect":
      return `use the record of ${t.value} instead`
    case "exp":
      return `explanation text at ${t.value}`
    default:
      return t.modifier ? "unknown modifier, ignored" : "unknown mechanism (permerror)"
  }
}

/** The all-term of the root record, as an answer to "what happens to other senders?" */
const AllVerdict = ({ node }: { readonly node: Node }): Html | null => {
  const all = node.terms.find((t) => !t.modifier && t.type === "all")
  const redirect = node.terms.find((t) => t.type === "redirect" && t.child)
  if (!all && redirect) return <Status level="ok">Defers to the record of <code>{redirect.value}</code>.</Status>
  if (!all) return <Status level="warn">No "all" at the end: mail from other servers gets a neutral result.</Status>
  switch (all.qualifier) {
    case "-":
      return <Status level="ok">Mail from any other server fails SPF (-all).</Status>
    case "~":
      return <Status level="ok">Mail from any other server soft-fails SPF (~all): accepted but marked.</Status>
    case "?":
      return <Status level="warn">Mail from any other server is neutral (?all): SPF does nothing.</Status>
    default:
      return <Status level="bad">Any server on the internet passes SPF (+all).</Status>
  }
}

const Lookup = ({ n }: { readonly n: number }) => (
  <span class={n > MAX_LOOKUPS ? "bad" : "muted"}> · lookup {n}/{MAX_LOOKUPS}</span>
)

const TreeNode = ({ node }: { readonly node: Node }): Html => (
  <>
    <code>
      <b>{node.domain}</b>
    </code>
    {node.ms > 0 ? <span class="muted"> · {node.ms} ms</span> : null}
    {node.note ? <> <Status level="bad">{node.note}</Status></> : null}
    {node.terms.length > 0
      ? (
        <ul class="tree">
          {node.terms.map((t) => (
            <li>
              <code>{t.raw}</code> <span class="muted">{describeTerm(t)}</span>
              {t.lookup !== null ? <Lookup n={t.lookup} /> : null}
              {t.child ? <ul class="tree"><li><TreeNode node={t.child} /></li></ul> : null}
            </li>
          ))}
        </ul>
      )
      : null}
  </>
)

const Result = ({ result }: { readonly result: Result }) => {
  const { node, lookups } = result
  const budget: Level = lookups > MAX_LOOKUPS ? "bad" : lookups > 7 ? "warn" : "ok"
  const blocking = result.issues.some((i) => i.level === "bad")
  return (
    <>
      <Summary
        items={[
          ["DNS lookups", `${lookups} of ${MAX_LOOKUPS}`],
          ["Issues", result.issues.length],
          ["Source", result.draft ? "draft record" : "published record"],
          ["Resolver", Doh.RESOLVERS[result.resolver].label],
          ["Time", `${result.queryTime} ms`],
        ]}
      />
      {node.record === null
        ? <p><Status level="bad">{node.note ?? "No SPF record."}</Status></p>
        : (
          <>
            <pre class="block">{node.record}</pre>
            <ul class="plain">
              <li><AllVerdict node={node} /></li>
              <li>
                <Status level={budget}>
                  {lookups} of {MAX_LOOKUPS} allowed DNS lookups used
                  {lookups > MAX_LOOKUPS ? ". Receivers return permerror; flatten your includes." : "."}
                </Status>
              </li>
              {result.issues.filter((i) => !i.text.startsWith(TOO_MANY)).map((i) => (
                <li>
                  <Status level={i.level}>
                    {i.domain === result.domain ? null : <><code>{i.domain}</code>: </>}
                    {i.text}
                  </Status>
                </li>
              ))}
              {blocking ? null : <li><Status level="ok">No blocking problems found.</Status></li>}
            </ul>
            <h3>Include tree</h3>
            <TreeNode node={node} />
          </>
        )}
    </>
  )
}

export const spfValidator = Tool.make<Input, Result>({
  slug: "spf-validator",
  title: "SPF validator",
  summary: "Walk a domain's SPF record and every include, and count the 10-lookup budget.",
  category: "Email",
  params: {
    domain: { description: "Domain whose SPF record to walk", required: true },
    resolver: { description: "DNS-over-HTTPS resolver", default: "cloudflare", values: Doh.RESOLVER_NAMES },
    record: { description: `A draft SPF record to check instead of the published one (at most ${MAX_RECORD_LENGTH} characters)` },
  },
  parse,
  run: evaluateSpf,
  Form,
  Result,
  examples: [
    { label: "google.com", query: "domain=google.com" },
    { label: "microsoft.com", query: "domain=microsoft.com" },
    { label: "a draft record", query: `domain=example.com&record=${encodeURIComponent("v=spf1 mx include:_spf.google.com ~all")}` },
  ],
})
