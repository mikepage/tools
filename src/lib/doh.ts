// DNS over HTTPS with the JSON API (application/dns-json), from Cloudflare's
// 1.1.1.1 resolvers or Google's. Shared by the DNS, email and network tools.

import { type Cause, Duration, Effect, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { UpstreamError } from "../tools/Tool.ts"

export const RESOLVERS = {
  cloudflare: { label: "Cloudflare 1.1.1.1", url: "https://cloudflare-dns.com/dns-query" },
  "cloudflare-security": { label: "Cloudflare 1.1.1.2 (malware)", url: "https://security.cloudflare-dns.com/dns-query" },
  "cloudflare-family": { label: "Cloudflare 1.1.1.3 (family)", url: "https://family.cloudflare-dns.com/dns-query" },
  google: { label: "Google 8.8.8.8", url: "https://dns.google/resolve" },
} as const
export type Resolver = keyof typeof RESOLVERS
export const RESOLVER_NAMES = Object.keys(RESOLVERS) as ReadonlyArray<Resolver>
export const ResolverParam = Schema.String.pipe(Schema.decodeTo(Schema.Literals(RESOLVER_NAMES)))

/** RCODE -> text. */
export const DNS_STATUS: Readonly<Record<number, string>> = {
  0: "No error",
  1: "Format error",
  2: "Server failure",
  3: "Non-existent domain",
  4: "Not implemented",
  5: "Query refused",
}

export const DohAnswer = Schema.Struct({ name: Schema.String, type: Schema.Number, TTL: Schema.Number, data: Schema.String })
export type DohAnswer = typeof DohAnswer.Type

export const DohResponse = Schema.Struct({
  Status: Schema.Number,
  TC: Schema.optional(Schema.Boolean),
  RD: Schema.optional(Schema.Boolean),
  RA: Schema.optional(Schema.Boolean),
  AD: Schema.optional(Schema.Boolean),
  CD: Schema.optional(Schema.Boolean),
  Answer: Schema.optional(Schema.Array(DohAnswer)),
  Authority: Schema.optional(Schema.Array(DohAnswer)),
})
export type DohResponse = typeof DohResponse.Type

export interface QueryOptions {
  readonly resolver?: Resolver
  /** true (default) asks for validation (do=1); false disables checking (cd=1). */
  readonly dnssec?: boolean
  readonly timeout?: Duration.Input
}

const describe = (cause: { readonly _tag: string; readonly message?: string }): string =>
  cause._tag === "TimeoutError" ? "the resolver did not answer in time" : cause.message ?? cause._tag

/** One DoH query, with its round-trip time in milliseconds. */
export const query = Effect.fnUntraced(function*(name: string, type: string, options: QueryOptions = {}) {
  const client = yield* HttpClient.HttpClient
  const dnssec = options.dnssec ?? true
  const [elapsed, response] = yield* client.get(RESOLVERS[options.resolver ?? "cloudflare"].url, {
    urlParams: { name, type, ...(dnssec ? { do: "1" } : { cd: "1" }) },
    headers: { accept: "application/dns-json" },
  }).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(DohResponse)),
    Effect.timeout(options.timeout ?? "5 seconds"),
    Effect.timed,
    Effect.mapError((cause: { readonly _tag: string; readonly message?: string } | Cause.TimeoutError) =>
      new UpstreamError({ message: `DNS lookup of ${name} ${type} failed: ${describe(cause)}`, cause })
    ),
  )
  return { response, ms: Math.round(Duration.toMillis(elapsed)) }
})

/** The answers of one type, without the CNAME chain that led to them. */
export const answersOf = (response: DohResponse, typeCode: number): ReadonlyArray<DohAnswer> =>
  (response.Answer ?? []).filter((a) => a.type === typeCode)

/** TXT data arrives as quoted strings: `"part1" "part2"`. */
export const unquoteTxt = (data: string): string => data.split(/"\s+"/).map((s) => s.replace(/^"|"$/g, "")).join("")

export const noDot = (name: string): string => name.replace(/\.$/, "")
