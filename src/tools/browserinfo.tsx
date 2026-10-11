// Browser info: what this Worker sees of the visitor's request. The headers,
// the User-Agent Client Hints, Cloudflare's `request.cf` (location, network,
// TLS, HTTP protocol) and the IP with its PTR record. No client JavaScript.
//
// Client Hints beyond the low-entropy three (Sec-CH-UA, -Mobile, -Platform)
// arrive only after a response has asked for them with `Accept-CH`; the app
// sets that header (CLIENT_HINTS below) on this tool's responses.

import { Check, KeyValue, Status, Summary, Table } from "../app/ui.tsx"
import * as Ip from "../lib/browserinfo-ip.ts"
import * as CfData from "../lib/ip-info-cf.ts"
import { flag } from "../lib/params.ts"
import * as Tool from "./Tool.ts"

// --- Client Hints (pure) --------------------------------------------------------

/** The hints worth asking for, as they go in `Accept-CH` and `Vary`. */
export const CLIENT_HINTS = [
  "Sec-CH-UA",
  "Sec-CH-UA-Mobile",
  "Sec-CH-UA-Platform",
  "Sec-CH-UA-Platform-Version",
  "Sec-CH-UA-Full-Version-List",
  "Sec-CH-UA-Model",
  "Sec-CH-UA-Arch",
  "Sec-CH-UA-Bitness",
] as const

export interface Brand {
  readonly brand: string
  readonly version: string
}

/** A brand list is a structured header: "Chromium";v="128", "Google Chrome";v="128". */
export const parseBrands = (header: string): ReadonlyArray<Brand> =>
  [...header.matchAll(/"((?:[^"\\]|\\.)*)"\s*;\s*v="([^"]*)"/g)].map((m) => ({ brand: m[1]!, version: m[2]! }))

// Skip the GREASE entry ("Not;A=Brand", "Not A(Brand") and prefer a real
// brand over the generic "Chromium".
const pickBrand = (brands: ReadonlyArray<Brand>): Brand | undefined => {
  const real = brands.filter((b) => !/not.?a.?brand/i.test(b.brand))
  return real.find((b) => b.brand !== "Chromium") ?? real[0]
}

// Structured-header strings arrive quoted: "macOS".
const unquote = (s: string): string => s.trim().replace(/^"(.*)"$/, "$1")

export interface ClientHints {
  readonly browser?: string | undefined
  readonly platform?: string | undefined
  readonly platformVersion?: string | undefined
  readonly mobile?: boolean | undefined
  readonly model?: string | undefined
  readonly arch?: string | undefined
  readonly bitness?: string | undefined
  /** The hint headers as received, by lowercase name. */
  readonly raw: Readonly<Record<string, string>>
}

export const clientHints = (headers: Headers): ClientHints => {
  const header = (name: string) => headers.get(name) ?? undefined
  const brandOf = (name: string) => {
    const h = header(name)
    return h === undefined ? undefined : pickBrand(parseBrands(h))
  }
  // The full version list is high-entropy and more precise; fall back to Sec-CH-UA.
  const brand = brandOf("Sec-CH-UA-Full-Version-List") ?? brandOf("Sec-CH-UA")
  const str = (name: string) => {
    const h = header(name)
    const s = h === undefined ? "" : unquote(h)
    return s === "" ? undefined : s
  }
  const mobile = header("Sec-CH-UA-Mobile")
  return {
    browser: brand ? `${brand.brand} ${brand.version}` : undefined,
    platform: str("Sec-CH-UA-Platform"),
    platformVersion: str("Sec-CH-UA-Platform-Version"),
    mobile: mobile === undefined ? undefined : mobile.trim() === "?1",
    model: str("Sec-CH-UA-Model"),
    arch: str("Sec-CH-UA-Arch"),
    bitness: str("Sec-CH-UA-Bitness"),
    raw: Object.fromEntries(CLIENT_HINTS.flatMap((h) => {
      const v = header(h)
      return v === undefined ? [] : [[h.toLowerCase(), v]]
    })),
  }
}

// --- User-Agent (pure) ----------------------------------------------------------

/**
 * Browser and OS from the User-Agent string, for browsers that send no
 * Client Hints (Firefox, Safari). Major versions only; order matters, since
 * Edge and Opera also say Chrome, and Chrome also says Safari.
 */
export const parseUserAgent = (ua: string): { readonly browser?: string; readonly os?: string } => {
  const browsers: ReadonlyArray<readonly [RegExp, string]> = [
    [/Edg(?:e|A|iOS)?\/(\d+)/, "Edge"],
    [/OPR\/(\d+)/, "Opera"],
    [/SamsungBrowser\/(\d+)/, "Samsung Internet"],
    [/(?:Firefox|FxiOS)\/(\d+)/, "Firefox"],
    [/(?:Chrome|CriOS)\/(\d+)/, "Chrome"],
    [/Version\/(\d+)[\d.]*.*Safari\//, "Safari"],
  ]
  const systems: ReadonlyArray<readonly [RegExp, string]> = [
    [/iPhone|iPad|iPod/, "iOS"],
    [/Android/, "Android"],
    [/CrOS/, "ChromeOS"],
    [/Windows/, "Windows"],
    [/Mac OS X|Macintosh/, "macOS"],
    [/Linux/, "Linux"],
  ]
  const hit = browsers.flatMap(([re, name]) => {
    const m = ua.match(re)
    return m ? [`${name} ${m[1]}`] : []
  })[0]
  const os = systems.find(([re]) => re.test(ua))?.[1]
  return { ...(hit !== undefined ? { browser: hit } : {}), ...(os !== undefined ? { os } : {}) }
}

// --- Input ----------------------------------------------------------------------

export interface Input {
  /** Look up the visitor's PTR record; `ptr=off` skips it. */
  readonly ptr: boolean
}

export const parse = (query: Tool.Query): Input => ({ ptr: flag(query, "ptr", true) })

// --- Result ---------------------------------------------------------------------

// The plain headers worth showing; Client Hints are reported on their own.
export const HEADERS = ["user-agent", "accept", "accept-language", "accept-encoding", "dnt", "sec-gpc", "referer"] as const

// The parts of request.cf shown, in display order.
const CF_KEYS = [
  "colo",
  "country",
  "city",
  "region",
  "postalCode",
  "timezone",
  "asn",
  "asOrganization",
  "httpProtocol",
  "tlsVersion",
  "tlsCipher",
] as const satisfies ReadonlyArray<CfData.CfKey>

export interface Result {
  readonly ip?: string | undefined
  readonly version?: 4 | 6 | undefined
  readonly ptr: Ip.Ptr | null
  /** The lookup was tried and failed; the rest of the answer still stands. */
  readonly ptrError?: string | undefined
  readonly cf: Readonly<Record<string, string>>
  readonly headers: Readonly<Record<string, string>>
  readonly clientHints: ClientHints
  readonly userAgent: { readonly browser?: string; readonly os?: string }
}

const definedEntries = (pairs: ReadonlyArray<readonly [string, string | undefined]>): Record<string, string> =>
  Object.fromEntries(pairs.filter((p): p is readonly [string, string] => p[1] !== undefined))

export const run = async (input: Input, visitor: Tool.Visitor): Promise<Result> => {
  const { ip, cf } = visitor

  // A failed lookup does not fail the whole answer: it is reported next to it.
  const name = ip !== undefined && input.ptr && !Ip.isPrivate(ip) ? Ip.reverseName(ip) : undefined
  let ptr: Pick<Result, "ptr" | "ptrError"> = { ptr: null }
  if (ip !== undefined && name !== undefined) {
    try {
      ptr = { ptr: await Ip.ptr(ip, name) }
    } catch (e) {
      if (!(e instanceof Tool.UpstreamError)) throw e
      ptr = { ptr: null, ptrError: e.message }
    }
  }

  return {
    ip,
    version: ip !== undefined ? CfData.ipVersion(ip) : undefined,
    ...ptr,
    cf: definedEntries(CF_KEYS.map((k) => [k, CfData.cfString(cf, k)])),
    headers: definedEntries(HEADERS.map((h) => [h, visitor.headers.get(h) ?? undefined])),
    clientHints: clientHints(visitor.headers),
    userAgent: parseUserAgent(visitor.headers.get("user-agent") ?? ""),
  }
}

// --- Views ----------------------------------------------------------------------

const Form = ({ query }: { readonly query: Tool.Query }) => (
  <Check label="Reverse DNS" name="ptr" checked={!/^(false|0|off)$/i.test(query["ptr"] ?? "")} />
)

const ReverseDns = ({ result, input }: { readonly result: Result; readonly input: Input }) => {
  if (result.ptr !== null) {
    return result.ptr.hostname !== null
      ? <code>{result.ptr.hostnames.join(", ")}</code>
      : <span class="muted">no PTR record</span>
  }
  if (result.ptrError !== undefined) return <Status level="warn">{result.ptrError}</Status>
  if (result.ip === undefined) return null
  if (!input.ptr) return <span class="muted">not looked up</span>
  return <span class="muted">private address, not looked up</span>
}

const Result = ({ result, input }: { readonly result: Result; readonly input: Input }) => {
  const hints = result.clientHints
  const cf = result.cf
  const country = cf["country"]
  const network = cf["asn"] ? `AS${cf["asn"]}${cf["asOrganization"] ? ` ${cf["asOrganization"]}` : ""}` : cf["asOrganization"]
  const hasCf = Object.keys(cf).length > 0
  const hintRows = Object.entries(hints.raw)
  const headerRows = Object.entries(result.headers)
  return (
    <>
      <Summary
        items={[
          ["Browser", hints.browser ?? result.userAgent.browser ?? "unknown"],
          ["Platform", [hints.platform ?? result.userAgent.os, hints.platformVersion].filter(Boolean).join(" ") || "unknown"],
          ...(hints.mobile !== undefined ? [["Mobile", hints.mobile ? "yes" : "no"] as const] : []),
          ...(cf["httpProtocol"] ? [["Protocol", cf["httpProtocol"]] as const] : []),
          ...(result.version !== undefined ? [["IP", `IPv${result.version}`] as const] : []),
        ]}
      />

      <h3>Connection</h3>
      <KeyValue
        rows={[
          ["IP address", result.ip !== undefined ? <code>{result.ip}</code> : <span class="muted">not on this request</span>],
          ["Reverse DNS", <ReverseDns result={result} input={input} />],
          ["HTTP protocol", cf["httpProtocol"]],
          ["TLS", cf["tlsVersion"]],
          ["TLS cipher", cf["tlsCipher"] ? <code>{cf["tlsCipher"]}</code> : undefined],
          ["Cloudflare colo", cf["colo"] ? <a href={`/cloudflare-edge?colo=${cf["colo"]}`}>{cf["colo"]}</a> : undefined],
        ]}
      />

      {hasCf
        ? (
          <>
            <h3>Location</h3>
            <KeyValue
              rows={[
                ["City", cf["city"]],
                ["Region", cf["region"]],
                ["Postal code", cf["postalCode"]],
                ["Country", country ? `${CfData.countryName(country)} (${country})` : undefined],
                ["Timezone", cf["timezone"]],
                ["Network", network],
              ]}
            />
          </>
        )
        : <p class="muted">No request.cf data. Cloudflare adds it at the edge.</p>}

      <h3>Client Hints</h3>
      {hintRows.length > 0
        ? <Table head={["Header", "Value"]} rows={hintRows.map(([k, v]) => [<code>{k}</code>, <code>{v}</code>])} />
        : <p class="muted">None received. Chromium browsers send them; Firefox and Safari do not.</p>}

      <h3>Headers</h3>
      {headerRows.length > 0
        ? <Table head={["Header", "Value"]} rows={headerRows.map(([k, v]) => [<code>{k}</code>, <code>{v}</code>])} />
        : <p class="muted">None of the usual headers were sent.</p>}
    </>
  )
}

export const browserinfo = Tool.make<Input, Result>({
  slug: "browserinfo",
  // Ask the browser to send its high-entropy Client Hints on the next request.
  responseHeaders: { "Accept-CH": CLIENT_HINTS.join(", "), Vary: CLIENT_HINTS.join(", ") },
  title: "Browser info",
  summary: "What a server sees of your request: headers, Client Hints, location, TLS and your IP with its reverse DNS.",
  category: "Network",
  params: {
    ptr: { description: "Look up the reverse DNS (PTR) of your IP; off skips it", default: "on" },
  },
  parse,
  autorun: true,
  run,
  Form,
  Result,
  examples: [
    { label: "Without reverse DNS", query: "ptr=off" },
  ],
})
