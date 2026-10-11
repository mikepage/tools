// RDAP lookup: a domain's registration data from its registry, the
// structured successor to WHOIS. The registry's RDAP server comes from a
// bundled copy of the IANA bootstrap registry.

import { DateTime, Duration, Effect, Schema, SchemaTransformation } from "effect"
import { HttpClient } from "effect/http"
import bootstrap from "../data/rdap-bootstrap.json" with { type: "json" }
import { Check, Field, KeyValue, Status, Summary, Table } from "../app/ui.tsx"
import { Domain } from "../lib/domain.ts"
import * as Tool from "./Tool.ts"

// --- Input ----------------------------------------------------------------------

const blank = (s: string | undefined) => (s === undefined || s.trim() === "" ? undefined : s)
const isOn = (s: string | undefined) => s !== undefined && /^(1|true|on|yes)$/i.test(s)

// `raw=1` adds the registry's full response to the JSON.
const Params = Schema.Struct({
  domain: Schema.optional(Schema.String),
  raw: Schema.optional(Schema.String),
}).pipe(
  Schema.decodeTo(
    Schema.Struct({ domain: Domain, raw: Schema.Boolean }),
    SchemaTransformation.transform({
      decode: (q) => ({ domain: blank(q.domain) ?? "", raw: isOn(q.raw) }),
      encode: (i) => ({ domain: i.domain, raw: i.raw ? "1" : "0" }),
    }),
  ),
)
type Input = typeof Params.Type

// --- The RDAP response ------------------------------------------------------------

// Only the fields the summary reads, all optional: registries differ, and one
// missing field should not fail the lookup. Unknown keys are ignored.
const RdapEntity = Schema.Struct({
  roles: Schema.optional(Schema.Array(Schema.String)),
  publicIds: Schema.optional(Schema.Array(Schema.Struct({ type: Schema.String, identifier: Schema.String }))),
  // jCard: ["vcard", [[name, params, type, value], ...]]
  vcardArray: Schema.optional(Schema.Tuple([Schema.String, Schema.Array(Schema.Array(Schema.Unknown))])),
})
type RdapEntity = typeof RdapEntity.Type

const DsRecord = Schema.Struct({
  keyTag: Schema.Number,
  algorithm: Schema.Number,
  digestType: Schema.Number,
  digest: Schema.String,
})
export type DsRecord = typeof DsRecord.Type

const RdapDomain = Schema.Struct({
  ldhName: Schema.optional(Schema.String),
  handle: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Array(Schema.String)),
  events: Schema.optional(Schema.Array(Schema.Struct({ eventAction: Schema.String, eventDate: Schema.String }))),
  nameservers: Schema.optional(Schema.Array(Schema.Struct({
    ldhName: Schema.optional(Schema.String),
    ipAddresses: Schema.optional(Schema.Struct({
      v4: Schema.optional(Schema.Array(Schema.String)),
      v6: Schema.optional(Schema.Array(Schema.String)),
    })),
  }))),
  entities: Schema.optional(Schema.Array(RdapEntity)),
  secureDNS: Schema.optional(Schema.Struct({
    delegationSigned: Schema.optional(Schema.Boolean),
    dsData: Schema.optional(Schema.Array(DsRecord)),
  })),
})
type RdapDomain = typeof RdapDomain.Type

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

const TIMEOUT = Duration.seconds(10)

export const lookup = Effect.fnUntraced(function*(input: Input) {
  const { domain } = input
  const rdapServer = serverFor(domain)
  if (!rdapServer) {
    const tld = domain.slice(domain.lastIndexOf(".") + 1)
    return yield* new Tool.UpstreamError({ message: `TLD ".${tld}" is not supported by RDAP: the IANA registry lists no server for it.` })
  }

  // Some registry servers drop idle keep-alive connections; retryTransient
  // retries a failed connection (or a 5xx) once.
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.retryTransient({ times: 1 }))

  const [elapsed, data] = yield* client.get(`${rdapServer}domain/${domain}`, {
    headers: { accept: "application/rdap+json", "user-agent": "tools.mikepage.nl rdap-lookup" },
  }).pipe(
    Effect.flatMap((res) =>
      Effect.gen(function*() {
        if (res.status === 404) return yield* new Tool.UpstreamError({ message: `Domain "${domain}" not found in RDAP registry.` })
        if (res.status < 200 || res.status >= 300) {
          return yield* new Tool.UpstreamError({ message: `RDAP lookup failed with status ${res.status}.` })
        }
        return yield* res.json
      })
    ),
    Effect.timeout(TIMEOUT),
    Effect.timed,
    Effect.mapError((cause) =>
      cause._tag === "UpstreamError" ? cause : new Tool.UpstreamError({
        message: cause._tag === "TimeoutError" ? "RDAP lookup timed out." : `RDAP lookup failed: ${cause.message}`,
        cause,
      })
    ),
  )

  const rdap = yield* Schema.decodeUnknownEffect(RdapDomain)(data).pipe(
    Effect.mapError((cause) => new Tool.UpstreamError({ message: `Unexpected RDAP response: ${cause.message}`, cause })),
  )
  const now = DateTime.toEpochMillis(yield* DateTime.now)

  return {
    ...summarize(domain, rdap, rdapServer, now),
    queryTimeMs: Math.round(Duration.toMillis(elapsed)),
    ...(input.raw ? { raw: data } : {}),
  } satisfies Result
})

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
  params: Params,
  run: lookup,
  Form,
  Result,
  examples: [
    { label: "cloudflare.com", query: "domain=cloudflare.com" },
    { label: "google.dev", query: "domain=google.dev" },
    { label: "sidn.nl", query: "domain=sidn.nl" },
  ],
})
