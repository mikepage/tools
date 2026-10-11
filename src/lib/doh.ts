// DNS over HTTPS with the JSON API (application/dns-json), from Cloudflare's
// 1.1.1.1 resolvers or Google's. Shared by the DNS, email and network tools.

import { getJson, isArrayOf, isRecord, since } from "./http.ts"

export const RESOLVERS = {
  cloudflare: { label: "Cloudflare 1.1.1.1", url: "https://cloudflare-dns.com/dns-query" },
  "cloudflare-security": { label: "Cloudflare 1.1.1.2 (malware)", url: "https://security.cloudflare-dns.com/dns-query" },
  "cloudflare-family": { label: "Cloudflare 1.1.1.3 (family)", url: "https://family.cloudflare-dns.com/dns-query" },
  google: { label: "Google 8.8.8.8", url: "https://dns.google/resolve" },
} as const
export type Resolver = keyof typeof RESOLVERS
export const RESOLVER_NAMES = Object.keys(RESOLVERS) as ReadonlyArray<Resolver>

/** RCODE -> text. */
export const DNS_STATUS: Readonly<Record<number, string>> = {
  0: "No error",
  1: "Format error",
  2: "Server failure",
  3: "Non-existent domain",
  4: "Not implemented",
  5: "Query refused",
}

export interface DohAnswer {
  readonly name: string
  readonly type: number
  readonly TTL: number
  readonly data: string
}

export interface DohResponse {
  readonly Status: number
  readonly TC?: boolean
  readonly RD?: boolean
  readonly RA?: boolean
  readonly AD?: boolean
  readonly CD?: boolean
  readonly Answer?: ReadonlyArray<DohAnswer>
  readonly Authority?: ReadonlyArray<DohAnswer>
}

const isAnswer = (v: unknown): v is DohAnswer =>
  isRecord(v) && typeof v["name"] === "string" && typeof v["type"] === "number" && typeof v["TTL"] === "number" &&
  typeof v["data"] === "string"

const isResponse = (v: unknown): v is DohResponse =>
  isRecord(v) && typeof v["Status"] === "number" &&
  (v["Answer"] === undefined || isArrayOf(v["Answer"], isAnswer)) &&
  (v["Authority"] === undefined || isArrayOf(v["Authority"], isAnswer))

export interface QueryOptions {
  readonly resolver?: Resolver
  /** true (default) asks for validation (do=1); false disables checking (cd=1). */
  readonly dnssec?: boolean
  /** Milliseconds; default 5000. */
  readonly timeout?: number
}

/** One DoH query, with its round-trip time in milliseconds. Throws UpstreamError. */
export const query = async (name: string, type: string, options: QueryOptions = {}) => {
  const url = new URL(RESOLVERS[options.resolver ?? "cloudflare"].url)
  url.searchParams.set("name", name)
  url.searchParams.set("type", type)
  url.searchParams.set((options.dnssec ?? true) ? "do" : "cd", "1")
  const start = performance.now()
  const response = await getJson(url, isResponse, {
    headers: { accept: "application/dns-json" },
    timeout: options.timeout ?? 5000,
    what: `DNS lookup of ${name} ${type}`,
  })
  return { response, ms: since(start) }
}

/** The answers of one type, without the CNAME chain that led to them. */
export const answersOf = (response: DohResponse, typeCode: number): ReadonlyArray<DohAnswer> =>
  (response.Answer ?? []).filter((a) => a.type === typeCode)

/** TXT data arrives as quoted strings: `"part1" "part2"`. */
export const unquoteTxt = (data: string): string => data.split(/"\s+"/).map((s) => s.replace(/^"|"$/g, "")).join("")

export const noDot = (name: string): string => name.replace(/\.$/, "")
