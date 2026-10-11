// Cloudflare edge: which data center served this request, where it is and
// how far it is from the visitor. The colo code and the visitor's location
// come from `request.cf`; the colo's city and coordinates from a bundled list.

import { Field, KeyValue, Status, Summary } from "../app/ui.tsx"
import data from "../data/colos.json" with { type: "json" }
import * as CfData from "../lib/ip-info-cf.ts"
import { optional } from "../lib/params.ts"
import * as Tool from "./Tool.ts"

// --- Colo data ------------------------------------------------------------------

export interface Colo {
  readonly code: string
  readonly city: string
  readonly country: string
  readonly cca2: string
  readonly region: string
  readonly lat?: number
  readonly lon?: number
}

// Cloudflare data centers by IATA code (github.com/Netrvin/cloudflare-colo-list, MIT).
const COLOS: Record<string, Omit<Colo, "code">> = data
export const COLO_COUNT = Object.keys(COLOS).length

export const findColo = (code: string): Colo | undefined => {
  const upper = code.trim().toUpperCase()
  const colo = Object.hasOwn(COLOS, upper) ? COLOS[upper] : undefined
  return colo === undefined ? undefined : { code: upper, ...colo }
}

export interface Point {
  readonly lat: number
  readonly lon: number
}

/** Great-circle distance in km (haversine). */
export const distanceKm = (a: Point, b: Point): number => {
  const rad = (d: number) => (d * Math.PI) / 180
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2
  return 2 * 6371 * Math.asin(Math.sqrt(h))
}

const pointOf = (c: Colo): Point | undefined =>
  c.lat !== undefined && c.lon !== undefined ? { lat: c.lat, lon: c.lon } : undefined

// --- Input ----------------------------------------------------------------------

export interface Input {
  /** A three-letter IATA code, uppercased; undefined for the serving colo. */
  readonly colo?: string | undefined
}

export const parse = (query: Tool.Query): Input => {
  const colo = optional(query, "colo")?.toUpperCase()
  if (colo === undefined) return {}
  if (!/^[A-Z]{3}$/.test(colo)) throw new Tool.InputError("colo: expected a three-letter IATA code")
  return { colo }
}

// --- Result ---------------------------------------------------------------------

export interface VisitorLocation {
  readonly city?: string | undefined
  readonly region?: string | undefined
  readonly country?: string | undefined
  readonly countryName?: string | undefined
  readonly continent?: string | undefined
  readonly lat?: number | undefined
  readonly lon?: number | undefined
}

export interface Result {
  /** The colo code in `request.cf`; null outside the edge. */
  readonly servedBy: string | null
  /** The looked-up colo, else the serving one; null when neither is known. */
  readonly colo: Colo | null
  /** Whether `colo` is the one serving this request. */
  readonly serving: boolean
  readonly visitor: VisitorLocation | null
  readonly distanceKm: number | null
}

export const run = async (input: Input, visitor: Tool.Visitor): Promise<Result> => {
  const { cf } = visitor
  const servedBy = CfData.cfString(cf, "colo")?.toUpperCase()

  // A looked-up colo must exist; the serving one may be missing from the list.
  let colo: Colo | undefined
  if (input.colo !== undefined) {
    colo = findColo(input.colo)
    if (colo === undefined) throw new Tool.InputError(`colo: unknown colo ${input.colo}`)
  } else if (servedBy !== undefined) {
    colo = findColo(servedBy)
  }

  const str = (key: CfData.CfKey) => CfData.cfString(cf, key)
  const lat = CfData.cfNumber(cf, "latitude")
  const lon = CfData.cfNumber(cf, "longitude")
  const country = str("country")
  const fields: VisitorLocation = {
    city: str("city"),
    region: str("region"),
    country,
    countryName: country !== undefined ? CfData.countryName(country) : undefined,
    continent: str("continent"),
    lat,
    lon,
  }
  // Null when request.cf is missing or says nothing about the visitor's location.
  const location = Object.values(fields).some((v) => v !== undefined) ? fields : null
  const there = colo !== undefined ? pointOf(colo) : undefined
  const distance = there !== undefined && lat !== undefined && lon !== undefined
    ? Math.round(distanceKm(there, { lat, lon }))
    : null

  return {
    servedBy: servedBy ?? null,
    colo: colo ?? null,
    serving: colo !== undefined && servedBy === colo.code,
    visitor: location,
    distanceKm: distance,
  }
}

// --- Views ----------------------------------------------------------------------

const Form = ({ query }: { readonly query: Tool.Query }) => (
  <Field label="Colo (optional)" name="colo" value={query["colo"]} placeholder="AMS" />
)

const km = (n: number) => `${n.toLocaleString("en-US")} km`

const Headline = ({ result }: { readonly result: Result }) => {
  const { colo } = result
  if (colo === null) {
    return result.servedBy !== null
      ? <p><Status level="warn">Served by {result.servedBy}, which is not in the bundled list.</Status></p>
      : <p class="muted">No Cloudflare data on this request. It is only there when the request comes through the edge.</p>
  }
  const where = `${colo.city}, ${colo.country}`
  return (
    <h2>
      {result.serving ? `Served from ${colo.code}: ${where}` : `${colo.code} is in ${where}`}
    </h2>
  )
}

const Result = ({ result }: { readonly result: Result }) => {
  const { colo, visitor } = result
  return (
    <>
      <Headline result={result} />
      <Summary
        items={[
          ...(result.distanceKm !== null ? [["Distance from you", km(result.distanceKm)] as const] : []),
          ...(result.servedBy !== null && !result.serving ? [["Serving you", result.servedBy] as const] : []),
          ["Data centers", COLO_COUNT],
        ]}
      />
      {colo !== null
        ? (
          <>
            <h3>Data center</h3>
            <KeyValue
              rows={[
                ["Code", <code>{colo.code}</code>],
                ["City", colo.city],
                ["Country", `${colo.country} (${colo.cca2})`],
                ["Region", colo.region],
                ["Coordinates", colo.lat !== undefined && colo.lon !== undefined ? `${colo.lat}, ${colo.lon}` : "unknown"],
              ]}
            />
          </>
        )
        : null}
      {visitor !== null
        ? (
          <>
            <h3>You, according to Cloudflare</h3>
            <KeyValue
              rows={[
                ["City", visitor.city],
                ["Region", visitor.region],
                ["Country", visitor.countryName && visitor.country ? `${visitor.countryName} (${visitor.country})` : undefined],
                ["Continent", visitor.continent],
                ["Coordinates", visitor.lat !== undefined && visitor.lon !== undefined ? `${visitor.lat}, ${visitor.lon}` : undefined],
              ]}
            />
          </>
        )
        : null}
    </>
  )
}

export const cloudflareEdge = Tool.make<Input, Result>({
  slug: "cloudflare-edge",
  title: "Cloudflare edge",
  summary: "Which Cloudflare data center serves you, where it is and how far away. Or look up any colo code.",
  category: "Network",
  params: {
    colo: { description: "Three-letter IATA code of a Cloudflare data center; default is the one serving you" },
  },
  parse,
  autorun: true,
  run,
  Form,
  Result,
  examples: [
    { label: "AMS", query: "colo=AMS" },
    { label: "NRT", query: "colo=NRT" },
    { label: "SJC", query: "colo=SJC" },
  ],
})
