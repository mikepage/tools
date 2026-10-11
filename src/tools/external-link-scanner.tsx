// External link scanner: crawl a site's own pages and list every external
// link, script, iframe and form target, grouped by destination domain, with
// the domains that look like injected spam flagged.

import { Field, Status, Summary, Table } from "../app/ui.tsx"
import { optional } from "../lib/params.ts"
import * as Tool from "./Tool.ts"

// Limits so one request can't crawl unbounded or hang. Each page is one
// subrequest; on the Workers Free plan anything past 50 fails and shows up
// as a page error.
export const MAX_PAGES_CAP = 100
const CONCURRENCY = 4
const TIMEOUT_MS = 12_000
// Rows per domain in the page; the JSON keeps every reference.
const ROWS_PER_DOMAIN = 50

// --- URLs and domains -------------------------------------------------------------

/** What people paste, as an http(s) URL; `example.com` means https. */
export const normalizeTarget = (raw: string): URL | undefined => {
  if (!raw) return undefined
  try {
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`)
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined
  } catch {
    return undefined
  }
}

// Common second-level registries, so shop.example.co.uk groups under example.co.uk.
const SECOND_LEVEL = new Set(["co", "com", "net", "org", "gov", "ac", "edu", "or", "ne"])

const isIpHost = (hostname: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":")

/** Approximate registrable domain (eTLD+1) without a full public-suffix list. */
export const registrableDomain = (hostname: string): string => {
  if (isIpHost(hostname)) return hostname.toLowerCase()
  const labels = hostname.toLowerCase().split(".").filter(Boolean)
  if (labels.length <= 2) return labels.join(".")
  const tld = labels[labels.length - 1]!
  const sld = labels[labels.length - 2]!
  return labels.slice(tld.length === 2 && SECOND_LEVEL.has(sld) ? -3 : -2).join(".")
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ""
  }
}

const sameSite = (url: string, siteDomain: string) => {
  const host = hostOf(url)
  return host !== "" && registrableDomain(host) === siteDomain
}

/** Resolves href against base: an absolute http(s) URL without fragment, or undefined. */
const resolveHttpUrl = (href: string, baseUrl: string): string | undefined => {
  try {
    const u = new URL(href.trim(), baseUrl)
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined
    u.hash = ""
    return u.href
  } catch {
    return undefined
  }
}

/** Canonical key for the visited set. */
const normalizeForVisit = (url: string) => {
  try {
    const u = new URL(url)
    u.hash = ""
    if (u.pathname !== "/" && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1)
    return u.href
  } catch {
    return url
  }
}

// Generic TLDs from before ICANN's 2013 new-gTLD expansion. With the
// two-letter country codes these are "standard"; newer ones (.xyz, .top, ...)
// are cheap, loosely policed and heavily abused for spam.
const CLASSIC_GTLDS = new Set([
  "com", "net", "org", "edu", "gov", "mil", "int", "arpa", "info", "biz", "name",
  "pro", "aero", "asia", "cat", "coop", "jobs", "mobi", "museum", "post", "tel", "travel",
])

const tldOf = (domain: string) => domain.toLowerCase().split(".").filter(Boolean).at(-1) ?? ""
const isStandardTld = (tld: string) => /^[a-z]{2}$/.test(tld) || CLASSIC_GTLDS.has(tld)

// --- Extracting references from HTML ----------------------------------------------
// HTMLRewriter streams the page through element handlers for the few tags that
// matter. Comments are never matched, so commented-out tags are skipped.

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
}

/** Minimal HTML-entity decode; HTMLRewriter hands out attributes and text undecoded. */
const decodeEntities = (s: string) =>
  s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : m
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? m
  })

const TEXT_MAX = 120

/** Visible text of an anchor: entities decoded, whitespace collapsed, capped. */
const cleanText = (raw: string) => {
  const text = decodeEntities(raw).replace(/\s+/g, " ").trim()
  return text.length <= TEXT_MAX ? text : text.slice(0, TEXT_MAX) + "…"
}

export interface PageRefs {
  readonly anchors: Array<{ readonly url: string; readonly text: string; readonly rel: string }>
  readonly scripts: Array<string>
  readonly iframes: Array<string>
  readonly forms: Array<string>
}

/** Links, scripts, iframes and form targets in a page, as absolute http(s) URLs. Reads the whole body. */
export const extractRefs = async (page: Response | string, baseUrl: string): Promise<PageRefs> => {
  const result: PageRefs = { anchors: [], scripts: [], iframes: [], forms: [] }
  const response = typeof page === "string" ? new Response(page, { headers: { "content-type": "text/html" } }) : page
  const resolve = (raw: string | null) => (raw ? resolveHttpUrl(decodeEntities(raw), baseUrl) : undefined)
  const collect = (attr: string, into: Array<string>): HTMLRewriterElementContentHandlers => ({
    element: (el) => {
      const abs = resolve(el.getAttribute(attr))
      if (abs) into.push(abs)
    },
  })
  // The anchor being read, so its text chunks land on it. A nested <a> is
  // invalid HTML; the innermost one gets the text.
  const open: Array<{ url: string; rel: string; text: string }> = []
  const rewriter = new HTMLRewriter()
    .on("a[href]", {
      element: (el) => {
        const url = resolve(el.getAttribute("href"))
        if (!url) return
        const anchor = { url, rel: decodeEntities(el.getAttribute("rel") ?? ""), text: "" }
        open.push(anchor)
        el.onEndTag(() => {
          const i = open.lastIndexOf(anchor)
          if (i >= 0) open.splice(i, 1)
          result.anchors.push({ url: anchor.url, text: cleanText(anchor.text), rel: anchor.rel })
        })
      },
      text: (chunk) => {
        const anchor = open.at(-1)
        // Stop collecting well past the cap; the rest is cut anyway.
        if (anchor && anchor.text.length < TEXT_MAX * 4) anchor.text += chunk.text
      },
    })
    .on("script[src]", collect("src", result.scripts))
    .on("iframe[src]", collect("src", result.iframes))
    .on("form[action]", collect("action", result.forms))
  await rewriter.transform(response).arrayBuffer()
  // An anchor without a closing tag never fired onEndTag.
  for (const anchor of open) result.anchors.push({ url: anchor.url, text: cleanText(anchor.text), rel: anchor.rel })
  return result
}

// --- The report ---------------------------------------------------------------------

export type RefKind = "link" | "script" | "iframe" | "form"

/** One reference from a scanned page to an external host. */
export interface ExternalRef {
  readonly url: string
  readonly host: string
  readonly kind: RefKind
  readonly page: string
  readonly text: string
  readonly rel: string
  readonly nofollow: boolean
}

/** All references to one external registrable domain. */
export interface DomainGroup {
  readonly domain: string
  readonly tld: string
  readonly suspicious: boolean
  readonly reasons: ReadonlyArray<string>
  readonly hosts: ReadonlyArray<string>
  readonly pages: ReadonlyArray<string>
  readonly refs: ReadonlyArray<ExternalRef>
}

export interface PageResult {
  readonly url: string
  readonly externalRefs: number
  readonly errors: ReadonlyArray<string>
}

export interface Result {
  readonly site: string
  readonly startedAt: string
  readonly finishedAt: string
  readonly pagesScanned: number
  readonly externalRefs: number
  readonly suspiciousDomains: number
  readonly domains: ReadonlyArray<DomainGroup>
  readonly pages: ReadonlyArray<PageResult>
}

// Keywords typical of SEO-spam link injections; a hit flags the domain.
const SPAM_KEYWORDS = [
  "casino", "poker", "slot", "betting", "gambl", "togel", "judi", "viagra", "cialis",
  "pharma", "pills", "porn", "xxx", "escort", "adult", "payday", "replica", "essay",
]

/** Why a domain looks suspicious; empty when it doesn't. */
export const assessDomain = (
  domain: string,
  tld: string,
  hosts: ReadonlyArray<string>,
  refs: ReadonlyArray<ExternalRef>,
): Array<string> => {
  const reasons: Array<string> = []
  if (isIpHost(domain)) reasons.push("raw IP address instead of a domain name")
  else if (!isStandardTld(tld)) reasons.push(`nonstandard TLD .${tld} (new gTLDs are heavily abused for spam and malware)`)
  if (hosts.some((h) => h.split(".").some((label) => label.startsWith("xn--")))) {
    reasons.push("punycode/IDN hostname (possible homograph spoofing)")
  }
  const spamHits = new Set<string>()
  for (const r of refs) {
    const s = `${r.url} ${r.text}`.toLowerCase()
    for (const k of SPAM_KEYWORDS) if (s.includes(k)) spamHits.add(k)
  }
  if (spamHits.size > 0) reasons.push(`SEO-spam keyword${spamHits.size > 1 ? "s" : ""}: ${[...spamHits].join(", ")}`)
  const active = refs.filter((r) => r.kind !== "link")
  if (active.length > 0 && reasons.length > 0) {
    reasons.push(`serves active content (${[...new Set(active.map((r) => r.kind))].join(", ")}) from a flagged domain`)
  }
  return reasons
}

/** Groups refs per registrable domain and flags suspicious ones; worst first. */
export const groupByDomain = (refs: ReadonlyArray<ExternalRef>): Array<DomainGroup> => {
  const byDomain = new Map<string, Array<ExternalRef>>()
  for (const ref of refs) {
    const domain = registrableDomain(ref.host)
    const list = byDomain.get(domain)
    if (list) list.push(ref)
    else byDomain.set(domain, [ref])
  }
  const groups = [...byDomain].map(([domain, domainRefs]): DomainGroup => {
    const hosts = [...new Set(domainRefs.map((r) => r.host))].sort()
    const pages = [...new Set(domainRefs.map((r) => r.page))].sort()
    const tld = tldOf(domain)
    const reasons = assessDomain(domain, tld, hosts, domainRefs)
    return { domain, tld, suspicious: reasons.length > 0, reasons, hosts, pages, refs: domainRefs }
  })
  return groups.sort((a, b) =>
    Number(b.suspicious) - Number(a.suspicious) || b.refs.length - a.refs.length || a.domain.localeCompare(b.domain)
  )
}

// --- Fetching and crawling -----------------------------------------------------------

const HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
}

interface ScannedPage {
  readonly result: PageResult
  readonly internalLinks: ReadonlyArray<string>
  readonly externalRefs: ReadonlyArray<ExternalRef>
}

const describeError = (error: unknown) =>
  error instanceof DOMException && error.name === "TimeoutError"
    ? `timed out after ${TIMEOUT_MS / 1000} s`
    : `fetch failed: ${error instanceof Error ? error.message : String(error)}`

// One page. A failure here is part of the report (a page error), not a
// failure of the scan, so this never throws: transport errors, timeouts and
// non-2xx statuses all become an error on the page. The timeout covers
// reading the body too.
const scanPage = async (url: string, siteDomain: string): Promise<ScannedPage> => {
  const internalLinks: Array<string> = []
  const externalRefs: Array<ExternalRef> = []
  const failed = (error: string): ScannedPage => ({ result: { url, externalRefs: 0, errors: [error] }, internalLinks, externalRefs })

  let refs: PageRefs
  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (res.status < 200 || res.status >= 300) {
      await res.body?.cancel()
      return failed(`HTTP ${res.status}`)
    }
    const contentType = res.headers.get("content-type") ?? ""
    // Only HTML is worth reading; anything else is skipped unread.
    if (!(contentType.includes("html") || contentType === "")) {
      await res.body?.cancel()
      return { result: { url, externalRefs: 0, errors: [] }, internalLinks, externalRefs }
    }
    refs = await extractRefs(res, res.url || url)
  } catch (error) {
    return failed(describeError(error))
  }

  const push = (target: string, kind: RefKind, text = "", rel = "") => {
    const host = hostOf(target)
    if (!host) return
    const nofollow = rel.toLowerCase().split(/[\s,]+/).includes("nofollow")
    externalRefs.push({ url: target, host, kind, page: url, text, rel, nofollow })
  }
  for (const a of refs.anchors) {
    if (sameSite(a.url, siteDomain)) internalLinks.push(a.url)
    else push(a.url, "link", a.text, a.rel)
  }
  for (const s of refs.scripts) if (!sameSite(s, siteDomain)) push(s, "script")
  for (const f of refs.iframes) if (!sameSite(f, siteDomain)) push(f, "iframe")
  for (const f of refs.forms) if (!sameSite(f, siteDomain)) push(f, "form")
  return { result: { url, externalRefs: externalRefs.length, errors: [] }, internalLinks, externalRefs }
}

/** Maps `items` with at most `limit` calls in flight; results keep the input order. */
const mapLimit = async <T, R>(items: ReadonlyArray<T>, limit: number, f: (item: T) => Promise<R>): Promise<Array<R>> => {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await f(items[i]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

// Breadth first: each level is fetched with at most CONCURRENCY requests in
// flight, and the links it finds become the next level, until maxPages pages
// have been fetched or nothing is left.
export const scan = async (input: Input): Promise<Result> => {
  const start = new URL(input.url)
  const startedAt = new Date().toISOString()
  const siteDomain = registrableDomain(start.hostname)
  const seen = new Set<string>([normalizeForVisit(start.href)])
  const pages: Array<PageResult> = []
  const refs: Array<ExternalRef> = []

  let frontier = [...seen]
  while (frontier.length > 0 && pages.length < input.maxPages) {
    const level = frontier.slice(0, input.maxPages - pages.length)
    const results = await mapLimit(level, CONCURRENCY, (url) => scanPage(url, siteDomain))
    frontier = []
    for (const { result, internalLinks, externalRefs } of results) {
      pages.push(result)
      refs.push(...externalRefs)
      // Bound the visited set too, so a page with thousands of links can't blow up memory.
      if (seen.size >= input.maxPages * 5) continue
      for (const link of internalLinks) {
        const key = normalizeForVisit(link)
        if (!seen.has(key)) {
          seen.add(key)
          frontier.push(key)
        }
      }
    }
  }

  // Nothing to report when even the start page failed.
  const first = pages[0]
  if (first && first.errors.length > 0) {
    throw new Tool.UpstreamError(`Could not fetch ${first.url}: ${first.errors.join(", ")}`)
  }

  const domains = groupByDomain(refs)
  return {
    site: start.origin,
    startedAt,
    finishedAt: new Date().toISOString(),
    pagesScanned: pages.length,
    externalRefs: refs.length,
    suspiciousDomains: domains.filter((d) => d.suspicious).length,
    domains,
    pages,
  }
}

// --- Input ----------------------------------------------------------------------------

export interface Input {
  /** Normalized http(s) URL. */
  readonly url: string
  readonly maxPages: number
}

export const parse = (query: Tool.Query): Input => {
  const url = normalizeTarget(optional(query, "url") ?? "")
  if (url === undefined) throw new Tool.InputError("url: please enter a valid http(s) URL, e.g. url=example.com")
  // Above the cap is clamped to it.
  const raw = optional(query, "maxPages")
  const maxPages = raw === undefined ? MAX_PAGES_CAP : Number(raw)
  if (!Number.isInteger(maxPages) || maxPages < 1) throw new Tool.InputError("maxPages: expected a whole number of 1 or more")
  return { url: url.href, maxPages: Math.min(maxPages, MAX_PAGES_CAP) }
}

// --- Views ------------------------------------------------------------------------------

const Form = ({ query }: { readonly query: Tool.Query }) => (
  <>
    <Field label="Site" name="url" value={query["url"]} placeholder="example.com" grow autofocus />
    <Field label="Max pages" name="maxPages" value={query["maxPages"] ?? String(MAX_PAGES_CAP)} type="number" />
  </>
)

const plural = (n: number, word: string) => `${n.toLocaleString("en")} ${word}${n === 1 ? "" : "s"}`

/** "12 links, 1 script" */
const kinds = (refs: ReadonlyArray<ExternalRef>): string => {
  const counts = new Map<RefKind, number>()
  for (const r of refs) counts.set(r.kind, (counts.get(r.kind) ?? 0) + 1)
  return (["link", "script", "iframe", "form"] as const)
    .filter((k) => counts.has(k))
    .map((k) => plural(counts.get(k)!, k))
    .join(", ")
}

/** The path of a page on the scanned site, for compact tables. */
const pathOf = (url: string, site: string) => (url.startsWith(site) ? url.slice(site.length) || "/" : url)

interface Target {
  readonly url: string
  readonly kind: RefKind
  readonly text: string
  readonly nofollow: boolean
  readonly pages: Set<string>
}

/** Each distinct URL + kind once, with the pages it appears on. */
const targetsOf = (refs: ReadonlyArray<ExternalRef>): Array<Target> => {
  const byKey = new Map<string, Target>()
  for (const r of refs) {
    const key = `${r.kind} ${r.url}`
    const t = byKey.get(key)
    if (t) {
      t.pages.add(r.page)
      if (!t.text && r.text) byKey.set(key, { ...t, text: r.text })
    } else {
      byKey.set(key, { url: r.url, kind: r.kind, text: r.text, nofollow: r.nofollow, pages: new Set([r.page]) })
    }
  }
  return [...byKey.values()].sort((a, b) => b.pages.size - a.pages.size || a.url.localeCompare(b.url))
}

const anchor = (domain: string) => `d-${domain}`

const DomainSection = ({ group, site }: { readonly group: DomainGroup; readonly site: string }) => {
  const targets = targetsOf(group.refs)
  const shown = targets.slice(0, ROWS_PER_DOMAIN)
  return (
    <>
      <h3 id={anchor(group.domain)}>{group.domain}</h3>
      {group.reasons.length > 0
        ? <ul class="plain">{group.reasons.map((r) => <li><Status level="warn">{r}</Status></li>)}</ul>
        : null}
      <p class="muted">
        {plural(group.hosts.length, "host")}: {group.hosts.join(", ")} · on {plural(group.pages.length, "page")}
      </p>
      <Table
        head={["Target", "Kind", "Pages", "Text"]}
        rows={shown.map((t) => [
          <a href={t.url} rel="nofollow noreferrer"><code>{t.url}</code></a>,
          t.kind === "link" && t.nofollow ? "link (nofollow)" : t.kind,
          t.pages.size === 1 ? <code>{pathOf([...t.pages][0]!, site)}</code> : t.pages.size,
          t.text ? t.text : <span class="muted">none</span>,
        ])}
      />
      {targets.length > shown.length
        ? <p class="muted">And {plural(targets.length - shown.length, "more target")}; the JSON has all of them.</p>
        : null}
    </>
  )
}

const seconds = (r: Result) => ((Date.parse(r.finishedAt) - Date.parse(r.startedAt)) / 1000).toFixed(1)

const Result = ({ result }: { readonly result: Result }) => {
  const failed = result.pages.filter((p) => p.errors.length > 0)
  return (
    <>
      <Summary
        items={[
          ["Site", result.site],
          ["Pages", result.pagesScanned],
          ["References", result.externalRefs],
          ["Domains", result.domains.length],
          ["Time", `${seconds(result)} s`],
        ]}
      />
      <p>
        {result.domains.length === 0
          ? <Status level="ok">No external links, scripts, iframes or forms found.</Status>
          : result.suspiciousDomains > 0
          ? <Status level="warn">{plural(result.suspiciousDomains, "domain")} {result.suspiciousDomains === 1 ? "looks" : "look"} suspicious.</Status>
          : <Status level="ok">No suspicious domains among {plural(result.domains.length, "external domain")}.</Status>}
      </p>
      {result.domains.length > 0
        ? (
          <>
            <h2>External domains</h2>
            <Table
              head={["Domain", "References", "Pages", ""]}
              rows={result.domains.map((d) => [
                <a href={`#${anchor(d.domain)}`}>{d.domain}</a>,
                kinds(d.refs),
                d.pages.length,
                d.suspicious ? <Status level="warn">suspicious</Status> : null,
              ])}
            />
            <h2>By domain</h2>
            {result.domains.map((group) => <DomainSection group={group} site={result.site} />)}
          </>
        )
        : null}
      {failed.length > 0
        ? (
          <>
            <h2>Pages with errors</h2>
            <Table
              head={["Page", "Error"]}
              rows={failed.map((p) => [<code>{pathOf(p.url, result.site)}</code>, p.errors.join(", ")])}
            />
          </>
        )
        : null}
    </>
  )
}

export const externalLinkScanner = Tool.make<Input, Result>({
  slug: "external-link-scanner",
  title: "External link scanner",
  summary: "Crawl a site and list every external link, script, iframe and form target by domain, with likely spam flagged.",
  category: "Web",
  params: {
    url: { description: "Site to crawl; a bare domain means https", required: true },
    maxPages: { description: `Pages to fetch, 1 to ${MAX_PAGES_CAP}; more is clamped`, default: String(MAX_PAGES_CAP) },
  },
  parse,
  run: scan,
  Form,
  Result,
  examples: [
    { label: "iana.org, 1 page", query: "url=https%3A%2F%2Fwww.iana.org%2Fhelp%2Fexample-domains&maxPages=1" },
    { label: "example.com", query: "url=example.com&maxPages=10" },
  ],
})
