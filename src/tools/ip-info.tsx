// IP info: the visitor's address and where Cloudflare places it, from
// `request.cf`. No geo-IP database, no upstream call. CORS-enabled JSON, so
// it can stand in for ipinfo.io or ip-api.

import { Effect, Option, Schema, SchemaTransformation } from "effect"
import { Field, KeyValue, Summary } from "../app/ui.tsx"
import * as CfData from "../lib/ip-info-cf.ts"
import * as Tool from "./Tool.ts"

// --- Result ---------------------------------------------------------------------

/** The ipinfo.io/json shape, with extras. Absent values are left out of the JSON. */
export interface IpInfo {
  readonly ip?: string | undefined
  readonly version?: 4 | 6 | undefined
  readonly city?: string | undefined
  readonly region?: string | undefined
  readonly regionCode?: string | undefined
  readonly country?: string | undefined
  readonly continent?: string | undefined
  readonly isEU?: boolean | undefined
  readonly postal?: string | undefined
  readonly metroCode?: string | undefined
  readonly loc?: string | undefined
  readonly timezone?: string | undefined
  readonly asn?: number | undefined
  readonly org?: string | undefined
  readonly colo?: string | undefined
}
export type Field = keyof IpInfo

export const FIELDS: ReadonlyArray<Field> = [
  "ip",
  "version",
  "city",
  "region",
  "regionCode",
  "country",
  "continent",
  "isEU",
  "postal",
  "metroCode",
  "loc",
  "timezone",
  "asn",
  "org",
  "colo",
]

/** What the visitor's IP and `cf` say, as one flat record. */
export const toIpInfo = (ip: Option.Option<string>, cf: Option.Option<CfData.Cf>): IpInfo => {
  const str = (key: CfData.CfKey) => Option.getOrUndefined(CfData.cfString(cf, key))
  const asn = Option.getOrUndefined(CfData.cfNumber(cf, "asn"))
  const org = str("asOrganization")
  const loc = Option.zipWith(CfData.cfString(cf, "latitude"), CfData.cfString(cf, "longitude"), (lat, lon) => `${lat},${lon}`)
  return {
    ip: Option.getOrUndefined(ip),
    version: Option.getOrUndefined(Option.map(ip, CfData.ipVersion)),
    city: str("city"),
    region: str("region"),
    regionCode: str("regionCode"),
    country: str("country"),
    continent: str("continent"),
    isEU: Option.exists(CfData.cfString(cf, "isEUCountry"), (v) => v === "1" || v === "true"),
    postal: str("postalCode"),
    metroCode: str("metroCode"),
    loc: Option.getOrUndefined(loc),
    timezone: str("timezone"),
    asn,
    org: asn !== undefined ? `AS${asn}${org ? ` ${org}` : ""}` : org,
    colo: str("colo"),
  }
}

/** The fields asked for, in the order asked. */
export const pick = (info: IpInfo, fields: ReadonlyArray<Field>): IpInfo =>
  Object.fromEntries(fields.map((f) => [f, info[f]]))

// --- Input ----------------------------------------------------------------------

export const splitFields = (s: string): ReadonlyArray<string> =>
  s.split(",").map((f) => f.trim()).filter((f) => f !== "")

const isField = (f: string): f is Field => (FIELDS as ReadonlyArray<string>).includes(f)

// `fields=ip,country` picks a subset, like ipinfo.io's field filter.
const FieldList = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((s: string) => splitFields(s).every(isField), {
      message: `fields must be a comma-separated list of: ${FIELDS.join(", ")}`,
    }),
  ),
  Schema.decodeTo(
    Schema.Array(Schema.Literals(FIELDS)),
    SchemaTransformation.transform({ decode: (s): ReadonlyArray<Field> => splitFields(s).filter(isField), encode: (fs) => fs.join(",") }),
  ),
)

const blank = (s: string | undefined) => (s === undefined || s.trim() === "" ? undefined : s)

const Params = Schema.Struct({
  fields: Schema.optional(Schema.String),
}).pipe(
  Schema.decodeTo(
    Schema.Struct({ fields: Schema.optional(FieldList) }),
    SchemaTransformation.transform({
      decode: (q): { readonly fields?: string | undefined } => ({ fields: blank(q.fields) }),
      encode: (i) => i,
    }),
  ),
)
type Input = typeof Params.Type

const run = Effect.fnUntraced(function*(input: Input) {
  const visitor = yield* Tool.Visitor
  const info = toIpInfo(visitor.ip, CfData.decodeCf(visitor.cf))
  return input.fields === undefined ? info : pick(info, input.fields)
})

// --- Views ----------------------------------------------------------------------

const Form = ({ query }: { readonly query: Tool.Query }) => (
  <Field label="Fields (optional)" name="fields" value={query["fields"]} placeholder="ip,city,country" grow />
)

const place = (info: IpInfo): string | undefined => {
  const country = info.country ? CfData.countryName(info.country) : undefined
  const parts = [info.city, info.region, country].filter((p): p is string => p !== undefined && p !== "")
  return parts.length > 0 ? [...new Set(parts)].join(", ") : undefined
}

const mapLink = (loc: string) => (
  <a href={`https://www.openstreetmap.org/?mlat=${loc.split(",")[0]}&mlon=${loc.split(",")[1]}&zoom=10`}>{loc}</a>
)

const Result = ({ result }: { readonly result: IpInfo }) => {
  const where = place(result)
  return (
    <>
      {result.ip !== undefined
        ? <h2 class="mono break">{result.ip}</h2>
        : "ip" in result
        ? <p class="muted">No client IP on this request. Cloudflare adds it at the edge.</p>
        : null}
      <Summary
        items={[
          ...(result.version !== undefined ? [["Version", `IPv${result.version}`] as const] : []),
          ...(where !== undefined ? [["Location", where] as const] : []),
          ...(result.org !== undefined ? [["Network", result.org] as const] : []),
        ]}
      />
      <KeyValue
        rows={[
          ["City", result.city],
          ["Region", result.region && result.regionCode ? `${result.region} (${result.regionCode})` : result.region],
          ["Country", result.country ? `${CfData.countryName(result.country)} (${result.country})` : undefined],
          ["Continent", result.continent],
          ["EU", "isEU" in result && result.country !== undefined ? (result.isEU ? "yes" : "no") : undefined],
          ["Postal code", result.postal],
          ["Metro code", result.metroCode],
          ["Coordinates", result.loc ? mapLink(result.loc) : undefined],
          ["Timezone", result.timezone],
          ["Network", result.org],
          ["Cloudflare colo", result.colo ? <a href={`/cloudflare-edge?colo=${result.colo}`}>{result.colo}</a> : undefined],
        ]}
      />
      {result.ip !== undefined && result.country === undefined && result.city === undefined
        ? <p class="muted">No location data: Cloudflare's request.cf is only there at the edge.</p>
        : null}
    </>
  )
}

export const ipInfo = Tool.make<Input, IpInfo>({
  slug: "ip-info",
  title: "IP info",
  summary: "Your IP address and where it is: city, country, timezone and network, from Cloudflare's request data.",
  category: "Network",
  params: Params,
  autorun: true,
  run,
  Form,
  Result,
  examples: [
    { label: "Just IP and country", query: "fields=ip,country" },
  ],
})
