// DNS lookup: one record type for a name, over DNS-over-HTTPS.

import { Check, Field, KeyValue, Select, Status, Summary, Table } from "../app/ui.tsx"
import * as Doh from "../lib/doh.ts"
import { domainParam } from "../lib/domain.ts"
import { flag, oneOf } from "../lib/params.ts"
import * as Tool from "./Tool.ts"

export const RECORD_TYPES = ["A", "AAAA", "CNAME", "MX", "NS", "TXT", "SOA", "CAA", "SRV", "PTR"] as const
export type RecordType = (typeof RECORD_TYPES)[number]

const TYPE_CODES: Record<RecordType, number> = {
  A: 1,
  AAAA: 28,
  CNAME: 5,
  MX: 15,
  NS: 2,
  TXT: 16,
  SOA: 6,
  CAA: 257,
  SRV: 33,
  PTR: 12,
}

// --- Input ----------------------------------------------------------------------

export interface Input {
  readonly name: string
  readonly type: RecordType
  readonly resolver: Doh.Resolver
  readonly dnssec: boolean
}

// `domain` is accepted as an alias for `name`, and `type=mx` as `MX`.
export const parse = (query: Tool.Query): Input => ({
  name: domainParam(query, ["name", "domain"]),
  type: oneOf(query, "type", RECORD_TYPES, "A"),
  resolver: oneOf(query, "resolver", Doh.RESOLVER_NAMES, "cloudflare"),
  dnssec: flag(query, "dnssec", true),
})

// --- Result ---------------------------------------------------------------------

export interface Mx {
  readonly preference: number
  readonly exchange: string
}

export interface Soa {
  readonly mname: string
  readonly rname: string
  readonly serial: number
  readonly refresh: number
  readonly retry: number
  readonly expire: number
  readonly minimum: number
}

export type RecordValue = string | Mx | Soa

export interface Result {
  readonly name: string
  readonly type: RecordType
  readonly resolver: Doh.Resolver
  readonly status: number
  readonly statusText: string
  readonly queryTime: number
  readonly dnssec: { readonly enabled: boolean; readonly validated: boolean }
  readonly records: ReadonlyArray<{ readonly ttl: number; readonly value: RecordValue }>
  /** The resolver's answer as it came. */
  readonly raw: Doh.DohResponse
}

export const parseRecord = (type: RecordType, data: string): RecordValue => {
  switch (type) {
    case "MX": {
      const [preference = "0", ...rest] = data.split(" ")
      return { preference: parseInt(preference, 10), exchange: Doh.noDot(rest.join(" ")) }
    }
    case "SOA": {
      const p = data.split(" ")
      const n = (i: number) => parseInt(p[i] ?? "", 10) || 0
      return {
        mname: Doh.noDot(p[0] ?? ""),
        rname: Doh.noDot(p[1] ?? ""),
        serial: n(2),
        refresh: n(3),
        retry: n(4),
        expire: n(5),
        minimum: n(6),
      }
    }
    case "TXT":
      return Doh.unquoteTxt(data)
    case "CNAME":
    case "NS":
    case "PTR":
    case "SRV":
      return Doh.noDot(data)
    default:
      return data
  }
}

export const lookup = async (input: Input): Promise<Result> => {
  const { response, ms } = await Doh.query(input.name, input.type, { resolver: input.resolver, dnssec: input.dnssec })
  return {
    name: input.name,
    type: input.type,
    resolver: input.resolver,
    status: response.Status,
    statusText: Doh.DNS_STATUS[response.Status] ?? `DNS error ${response.Status}`,
    queryTime: ms,
    dnssec: { enabled: input.dnssec, validated: response.AD === true },
    records: Doh.answersOf(response, TYPE_CODES[input.type]).map((a) => ({ ttl: a.TTL, value: parseRecord(input.type, a.data) })),
    raw: response,
  }
}

// --- Views ----------------------------------------------------------------------

const Form = ({ query }: { readonly query: Tool.Query }) => (
  <>
    <Field label="Name" name="name" value={query["name"] ?? query["domain"]} placeholder="example.com" grow autofocus />
    <Select label="Type" name="type" value={query["type"]?.toUpperCase() ?? "A"} options={RECORD_TYPES.map((t) => [t, t])} />
    <Select
      label="Resolver"
      name="resolver"
      value={query["resolver"] ?? "cloudflare"}
      options={Doh.RESOLVER_NAMES.map((r) => [r, Doh.RESOLVERS[r].label])}
    />
    <Check label="DNSSEC" name="dnssec" checked={query["dnssec"] === undefined || query["dnssec"] === "on"} />
  </>
)

const ttl = (seconds: number) => (seconds >= 3600 ? `${Math.round(seconds / 360) / 10} h` : seconds >= 60 ? `${Math.round(seconds / 60)} min` : `${seconds} s`)

const Records = ({ result }: { readonly result: Result }) => {
  if (result.records.length === 0) return <p class="muted">No {result.type} records.</p>
  switch (result.type) {
    case "MX":
      return (
        <Table
          head={["Priority", "Mail server", "TTL"]}
          rows={[...result.records].sort((a, b) => (a.value as Mx).preference - (b.value as Mx).preference).map((r) => {
            const mx = r.value as Mx
            return [mx.preference, <code>{mx.exchange}</code>, ttl(r.ttl)]
          })}
        />
      )
    case "SOA": {
      const soa = result.records[0]!.value as Soa
      return (
        <KeyValue
          rows={[
            ["Primary server", <code>{soa.mname}</code>],
            ["Contact", <code>{soa.rname}</code>],
            ["Serial", soa.serial],
            ["Refresh", ttl(soa.refresh)],
            ["Retry", ttl(soa.retry)],
            ["Expire", ttl(soa.expire)],
            ["Negative TTL", ttl(soa.minimum)],
          ]}
        />
      )
    }
    default:
      return <Table head={["Value", "TTL"]} rows={result.records.map((r) => [<code>{String(r.value)}</code>, ttl(r.ttl)])} />
  }
}

const Result = ({ result }: { readonly result: Result }) => (
  <>
    <Summary
      items={[
        ["Status", result.statusText],
        ["DNSSEC", result.dnssec.enabled ? (result.dnssec.validated ? "validated" : "not signed") : "not checked"],
        ["Resolver", Doh.RESOLVERS[result.resolver].label],
        ["Time", `${result.queryTime} ms`],
      ]}
    />
    {result.status !== 0
      ? <p><Status level="bad">{result.statusText}</Status></p>
      : <Records result={result} />}
  </>
)

export const dnsLookup = Tool.make<Input, Result>({
  slug: "dns-lookup",
  title: "DNS lookup",
  summary: "Look up A, AAAA, MX, TXT and other records over DNS-over-HTTPS, with DNSSEC validation.",
  category: "DNS & domains",
  params: {
    name: { description: "Domain or DNS name to query (alias: domain)", required: true },
    type: { description: "Record type", default: "A", values: RECORD_TYPES },
    resolver: { description: "DNS-over-HTTPS resolver", default: "cloudflare", values: Doh.RESOLVER_NAMES },
    dnssec: { description: "Ask for DNSSEC validation (on) or disable checking (off)", default: "on" },
  },
  parse,
  run: lookup,
  Form,
  Result,
  examples: [
    { label: "MX for gmail.com", query: "name=gmail.com&type=MX" },
    { label: "TXT for google.com", query: "name=google.com&type=TXT" },
    { label: "SOA for cloudflare.com", query: "name=cloudflare.com&type=SOA" },
  ],
})
