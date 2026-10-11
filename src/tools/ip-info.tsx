// IP info: the visitor's address and where Cloudflare places it, from
// `request.cf`. No geo-IP database, no upstream call. CORS-enabled JSON, so
// it can stand in for ipinfo.io or ip-api.

import { Field, KeyValue, Summary } from "../app/ui.tsx"
import * as CfData from "../lib/ip-info-cf.ts"
import { optional } from "../lib/params.ts"
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
export const toIpInfo = (ip: string | undefined, cf: CfData.Cf): IpInfo => {
  const str = (key: CfData.CfKey) => CfData.cfString(cf, key)
  const asn = CfData.cfNumber(cf, "asn")
  const org = str("asOrganization")
  const lat = str("latitude")
  const lon = str("longitude")
  const eu = str("isEUCountry")
  return {
    ip,
    version: ip !== undefined ? CfData.ipVersion(ip) : undefined,
    city: str("city"),
    region: str("region"),
    regionCode: str("regionCode"),
    country: str("country"),
    continent: str("continent"),
    isEU: eu === "1" || eu === "true",
    postal: str("postalCode"),
    metroCode: str("metroCode"),
    loc: lat !== undefined && lon !== undefined ? `${lat},${lon}` : undefined,
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

export interface Input {
  /** A subset of the fields, in the order asked; undefined for all of them. */
  readonly fields?: ReadonlyArray<Field> | undefined
}

// `fields=ip,country` picks a subset, like ipinfo.io's field filter.
export const parse = (query: Tool.Query): Input => {
  const raw = optional(query, "fields")
  if (raw === undefined) return {}
  const fields = splitFields(raw)
  if (!fields.every(isField)) throw new Tool.InputError(`fields: expected a comma-separated list of ${FIELDS.join(", ")}`)
  return { fields }
}

export const run = async (input: Input, visitor: Tool.Visitor): Promise<IpInfo> => {
  const info = toIpInfo(visitor.ip, visitor.cf)
  return input.fields === undefined ? info : pick(info, input.fields)
}

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
  params: {
    fields: { description: `Comma-separated subset of the fields: ${FIELDS.join(", ")}` },
  },
  parse,
  autorun: true,
  run,
  Form,
  Result,
  examples: [
    { label: "Just IP and country", query: "fields=ip,country" },
  ],
})
