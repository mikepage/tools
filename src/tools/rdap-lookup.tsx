// RDAP lookup: a domain's registration data from its registry, the
// structured successor to WHOIS. The registry's RDAP server comes from a
// bundled copy of the IANA bootstrap registry.

import bootstrap from "../data/rdap-bootstrap.json" with { type: "json" }
import { Check, Field, KeyValue, Status, Summary, Table } from "../app/ui.tsx"
import { domainParam } from "../lib/domain.ts"
import { isArrayOf, isRecord, since } from "../lib/http.ts"
import { flag } from "../lib/params.ts"
import * as Tool from "./Tool.ts"

// --- Input ----------------------------------------------------------------------

export interface Input {
  readonly domain: string
  readonly raw: boolean
}

// `raw=1` adds the registry's full response to the JSON.
export const parse = (query: Tool.Query): Input => ({
  domain: domainParam(query, ["domain"]),
  raw: flag(query, "raw", false),
})

// --- The RDAP response ------------------------------------------------------------

// Only the fields the summary reads, all optional: registries differ, and one
// missing field should not fail the lookup. Unknown keys are ignored.
interface RdapEntity {
  readonly roles?: ReadonlyArray<string>
  readonly publicIds?: ReadonlyArray<{ readonly type: string; readonly identifier: string }>
  // jCard: ["vcard", [[name, params, type, value], ...]]
  readonly vcardArray?: readonly [string, ReadonlyArray<ReadonlyArray<unknown>>]
}

export interface DsRecord {
  readonly keyTag: number
  readonly algorithm: number
  readonly digestType: number
  readonly digest: string
}

export interface RdapDomain {
  readonly ldhName?: string
  readonly handle?: string
  readonly status?: ReadonlyArray<string>
  readonly events?: ReadonlyArray<{ readonly eventAction: string; readonly eventDate: string }>
  readonly nameservers?: ReadonlyArray<{
    readonly ldhName?: string
    readonly ipAddresses?: { readonly v4?: ReadonlyArray<string>; readonly v6?: ReadonlyArray<string> }
  }>
  readonly entities?: ReadonlyArray<RdapEntity>
  readonly secureDNS?: { readonly delegationSigned?: boolean; readonly dsData?: ReadonlyArray<DsRecord> }
}

// Shape guards: what the summary reads must have the right type when present.
const isString = (v: unknown): v is string => typeof v === "string"
const isNumber = (v: unknown): v is number => typeof v === "number"
const opt = (v: unknown, check: (x: unknown) => boolean) => v === undefined || check(v)
const strings = (v: unknown) => isArrayOf(v, isString)

const isEntity = (v: unknown): v is RdapEntity =>
  isRecord(v) && opt(v["roles"], strings) &&
  opt(v["publicIds"], (x) => isArrayOf(x, (id): id is unknown => isRecord(id) && isString(id["type"]) && isString(id["identifier"]))) &&
  opt(v["vcardArray"], (x) => Array.isArray(x) && x.length === 2 && isString(x[0]) && isArrayOf(x[1], (row): row is unknown => Array.isArray(row)))

const isDsRecord = (v: unknown): v is DsRecord =>
  isRecord(v) && isNumber(v["keyTag"]) && isNumber(v["algorithm"]) && isNumber(v["digestType"]) && isString(v["digest"])

const isNameserver = (v: unknown): boolean =>
  isRecord(v) && opt(v["ldhName"], isString) &&
  opt(v["ipAddresses"], (ip) => isRecord(ip) && opt(ip["v4"], strings) && opt(ip["v6"], strings))

export const isRdapDomain = (v: unknown): v is RdapDomain =>
  isRecord(v) && opt(v["ldhName"], isString) && opt(v["handle"], isString) && opt(v["status"], strings) &&
  opt(v["events"], (x) => isArrayOf(x, (e): e is unknown => isRecord(e) && isString(e["eventAction"]) && isString(e["eventDate"]))) &&
  opt(v["nameservers"], (x) => isArrayOf(x, (ns): ns is unknown => isNameserver(ns))) &&
  opt(v["entities"], (x) => isArrayOf(x, isEntity)) &&
  opt(v["secureDNS"], (d) => isRecord(d) && opt(d["delegationSigned"], (b) => typeof b === "boolean") && opt(d["dsData"], (x) => isArrayOf(x, isDsRecord)))

// --- Result ---------------------------------------------------------------------

export type EventKey = "registration" | "expiration" | "lastChanged" | "lastUpdateOfRdapDatabase"

export interface Result {
  readonly domain: string
  readonly handle: string | null
  readonly registrar: string | null
  readonly ianaId: string | null
  /** RDAP status values, e.g. `client transfer prohibited`. */
  readonly status: ReadonlyArray<string>
  readonly events: Readonly<Record<EventKey, string | null>>
  /** Whole days until expiration; negative once expired. */
  readonly expiresInDays: number | null
  readonly nameservers: ReadonlyArray<{ readonly name: string; readonly ipv4: ReadonlyArray<string>; readonly ipv6: ReadonlyArray<string> }>
  readonly dnssec: { readonly delegationSigned: boolean; readonly dsData: ReadonlyArray<DsRecord> }
  readonly rdapServer: string
  readonly queryTimeMs: number
  readonly raw?: unknown
}

// --- Bootstrap ------------------------------------------------------------------

// TLD -> RDAP base URL, built once per isolate from the bundled registry.
const servers = new Map<string, string>(
  Object.entries(bootstrap.servers as Record<string, string>).flatMap(([url, tlds]) =>
    tlds.split(" ").map((tld) => [tld, url] as const)
  ),
)

/** The RDAP base URL for a domain's TLD, if the registry has one. */
export const serverFor = (domain: string): string | undefined => servers.get(domain.slice(domain.lastIndexOf(".") + 1))

// --- Parsing --------------------------------------------------------------------

const EVENT_ACTIONS: Readonly<Record<string, EventKey>> = {
  registration: "registration",
  expiration: "expiration",
  "last changed": "lastChanged",
  "last update of rdap database": "lastUpdateOfRdapDatabase",
}

const registrarName = (entity?: RdapEntity): string | null => {
  const fn = entity?.vcardArray?.[1].find((row) => row[0] === "fn")
  return typeof fn?.[3] === "string" && fn[3] ? fn[3] : null
}

const ianaId = (entity?: RdapEntity): string | null =>
  entity?.publicIds?.find((id) => id.type === "IANA Registrar ID")?.identifier || null

/** The first date of each event this tool knows about. */
export const eventsOf = (rdap: RdapDomain): Record<EventKey, string | null> => {
  const events: Record<EventKey, string | null> = {
    registration: null,
    expiration: null,
    lastChanged: null,
    lastUpdateOfRdapDatabase: null,
  }
  for (const ev of rdap.events ?? []) {
    const key = EVENT_ACTIONS[ev.eventAction.toLowerCase()]
    if (key && !events[key]) events[key] = ev.eventDate
  }
  return events
}

/** The decoded RDAP answer as this tool's summary (without timing or raw data). */
export const summarize = (domain: string, rdap: RdapDomain, rdapServer: string, now: number) => {
  const events = eventsOf(rdap)
  const expires = events.expiration ? Date.parse(events.expiration) : NaN
  const registrar = rdap.entities?.find((e) => e.roles?.includes("registrar"))
  return {
    domain: (rdap.ldhName ?? domain).toLowerCase(),
    handle: rdap.handle || null,
    registrar: registrarName(registrar),
    ianaId: ianaId(registrar),
    status: rdap.status ?? [],
    events,
    expiresInDays: Number.isNaN(expires) ? null : Math.floor((expires - now) / 86_400_000),
    nameservers: (rdap.nameservers ?? []).map((ns) => ({
      name: (ns.ldhName ?? "").toLowerCase(),
      ipv4: ns.ipAddresses?.v4 ?? [],
      ipv6: ns.ipAddresses?.v6 ?? [],
    })),
    dnssec: { delegationSigned: rdap.secureDNS?.delegationSigned ?? false, dsData: rdap.secureDNS?.dsData ?? [] },
    rdapServer,
  }
}

// --- The lookup -----------------------------------------------------------------

const TIMEOUT_MS = 10_000

const describeError = (error: unknown): string =>
  error instanceof DOMException && error.name === "TimeoutError"
    ? "RDAP lookup timed out."
    : `RDAP lookup failed: ${error instanceof Error ? error.message : String(error)}`

export const lookup = async (input: Input): Promise<Result> => {
  const { domain } = input
  const rdapServer = serverFor(domain)
  if (!rdapServer) {
    const tld = domain.slice(domain.lastIndexOf(".") + 1)
    throw new Tool.UpstreamError(`TLD ".${tld}" is not supported by RDAP: the IANA registry lists no server for it.`)
  }

  // One timeout for the whole lookup, retry included.
  const signal = AbortSignal.timeout(TIMEOUT_MS)
  const request = () =>
    fetch(`${rdapServer}domain/${domain}`, {
      headers: { accept: "application/rdap+json", "user-agent": "tools.mikepage.nl rdap-lookup" },
      signal,
    })

  const start = performance.now()
  let data: unknown
  try {
    // Some registry servers drop idle keep-alive connections: a failed
    // connection or a 5xx is retried once.
    let response: Response
    try {
      response = await request()
      if (response.status >= 500) {
        await response.body?.cancel()
        response = await request()
      }
    } catch (error) {
      if (signal.aborted) throw error
      response = await request()
    }
    if (response.status === 404) throw new Tool.UpstreamError(`Domain "${domain}" not found in RDAP registry.`)
    if (!response.ok) throw new Tool.UpstreamError(`RDAP lookup failed with status ${response.status}.`)
    data = await response.json()
  } catch (error) {
    if (error instanceof Tool.UpstreamError) throw error
    throw new Tool.UpstreamError(describeError(error))
  }
  const queryTimeMs = since(start)

  if (!isRdapDomain(data)) throw new Tool.UpstreamError("Unexpected RDAP response: the answer does not look like an RDAP domain.")

  return {
    ...summarize(domain, data, rdapServer, Date.now()),
    queryTimeMs,
    ...(input.raw ? { raw: data } : {}),
  }
}

// --- Views ----------------------------------------------------------------------

const Form = ({ query }: { readonly query: Tool.Query }) => (
  <>
    <Field label="Domain" name="domain" value={query["domain"]} placeholder="example.com" grow autofocus />
  </>
)

const day = (iso: string | null): string | null => (iso ? iso.slice(0, 10) : null)

// The status values people actually see, in words. Registries write them as
// `client transfer prohibited` (RDAP) or `clientTransferProhibited` (EPP).
const STATUS_WORDS: Readonly<Record<string, string>> = {
  active: "active",
  ok: "active",
  clienttransferprohibited: "transfer locked by registrar",
  servertransferprohibited: "transfer locked by registry",
  clientdeleteprohibited: "delete locked by registrar",
  serverdeleteprohibited: "delete locked by registry",
  clientupdateprohibited: "update locked by registrar",
  serverupdateprohibited: "update locked by registry",
  clientrenewprohibited: "renewal locked by registrar",
  serverrenewprohibited: "renewal locked by registry",
  clienthold: "on hold by registrar (not in DNS)",
  serverhold: "on hold by registry (not in DNS)",
  redemptionperiod: "expired, in redemption period",
  pendingdelete: "about to be deleted",
  inactive: "no nameservers",
}

const describeStatus = (s: string): string | undefined => STATUS_WORDS[s.replace(/\s+/g, "").toLowerCase()]

const Expiry = ({ days }: { readonly days: number | null }) =>
  days === null
    ? <span class="muted">not published</span>
    : days < 0
    ? <Status level="bad">expired {-days} days ago</Status>
    : days <= 30
    ? <Status level="warn">in {days} days</Status>
    : <Status level="ok">in {days} days</Status>

const Result = ({ result }: { readonly result: Result }) => {
  const e = result.events
  return (
    <>
      <Summary
        items={[
          ["Registrar", result.registrar ?? "unknown"],
          ["Expires", day(e.expiration) ?? "unknown"],
          ["DNSSEC", result.dnssec.delegationSigned ? "signed" : "not signed"],
          ["Time", `${result.queryTimeMs} ms`],
        ]}
      />
      <KeyValue
        rows={[
          ["Domain", <code>{result.domain}</code>],
          ["Registrar", result.registrar ? [result.registrar, result.ianaId ? <span class="muted"> · IANA ID {result.ianaId}</span> : null] : "unknown"],
          ["Registered", day(e.registration)],
          ["Expires", [day(e.expiration), e.expiration ? " " : null, <Expiry days={result.expiresInDays} />]],
          ["Last changed", day(e.lastChanged)],
          ["Registry handle", result.handle ? <code>{result.handle}</code> : null],
        ]}
      />

      <h3>Status</h3>
      {result.status.length === 0
        ? <p class="muted">No status published.</p>
        : (
          <ul class="plain">
            {result.status.map((s) => {
              const words = describeStatus(s)
              return <li><code>{s}</code>{words && words !== s ? <span class="muted"> · {words}</span> : null}</li>
            })}
          </ul>
        )}

      <h3>Nameservers</h3>
      {result.nameservers.length === 0
        ? <p class="muted">No nameservers delegated.</p>
        : (
          <Table
            head={["Nameserver", "Glue"]}
            rows={result.nameservers.map((ns) => [
              <code>{ns.name}</code>,
              ns.ipv4.length + ns.ipv6.length === 0
                ? <span class="muted">none</span>
                : [...ns.ipv4, ...ns.ipv6].map((ip, i) => [i > 0 ? <br /> : null, <code>{ip}</code>]),
            ])}
          />
        )}

      <h3>DNSSEC</h3>
      <p>
        {result.dnssec.delegationSigned
          ? <Status level="ok">Delegation signed: the registry publishes a DS record.</Status>
          : <Status level="warn">Not signed: the registry has no DS record for this domain.</Status>}
      </p>
      {result.dnssec.dsData.length > 0
        ? (
          <Table
            head={["Key tag", "Algorithm", "Digest type", "Digest"]}
            rows={result.dnssec.dsData.map((ds) => [ds.keyTag, ds.algorithm, ds.digestType, <code>{ds.digest}</code>])}
          />
        )
        : null}

      <p class="muted">
        From <code>{result.rdapServer}</code>
        {e.lastUpdateOfRdapDatabase ? `, data as of ${e.lastUpdateOfRdapDatabase.replace("T", " ").replace(/\.\d+/, "")}` : ""}.
      </p>
    </>
  )
}

export const rdapLookup = Tool.make<Input, Result>({
  slug: "rdap-lookup",
  title: "RDAP lookup",
  summary: "Registration data for a domain over RDAP, the successor to WHOIS: registrar, dates, status, nameservers, DNSSEC.",
  category: "DNS & domains",
  params: {
    domain: { description: "Domain to look up", required: true },
    raw: { description: "Add the registry's full RDAP response to the JSON (on/off)", default: "off" },
  },
  parse,
  run: lookup,
  Form,
  Result,
  examples: [
    { label: "cloudflare.com", query: "domain=cloudflare.com" },
    { label: "google.dev", query: "domain=google.dev" },
    { label: "sidn.nl", query: "domain=sidn.nl" },
  ],
})
