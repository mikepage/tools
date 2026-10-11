// Cloudflare edge: which data center served this request, where it is and
// how far it is from the visitor. The colo code and the visitor's location
// come from `request.cf`; the colo's city and coordinates from a bundled list.

import { Effect, Option, Record, Schema, SchemaTransformation } from "effect"
import { Field, KeyValue, Status, Summary } from "../app/ui.tsx"
import data from "../data/colos.json" with { type: "json" }
import * as CfData from "../lib/ip-info-cf.ts"
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

export const findColo = (code: string): Option.Option<Colo> => {
  const upper = code.trim().toUpperCase()
  return Option.map(Record.get(COLOS, upper), (c) => ({ code: upper, ...c }))
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

const pointOf = (c: Colo): Option.Option<Point> =>
  c.lat !== undefined && c.lon !== undefined ? Option.some({ lat: c.lat, lon: c.lon }) : Option.none()

// --- Input ----------------------------------------------------------------------

const ColoCode = Schema.String.pipe(
  Schema.decode(SchemaTransformation.transform({ decode: (s) => s.trim().toUpperCase(), encode: (s) => s })),
  Schema.check(Schema.makeFilter((s: string) => /^[A-Z]{3}$/.test(s), { message: "colo must be a three-letter IATA code" })),
)

const blank = (s: string | undefined) => (s === undefined || s.trim() === "" ? undefined : s)

const Params = Schema.Struct({
  colo: Schema.optional(Schema.String),
}).pipe(
  Schema.decodeTo(
    Schema.Struct({ colo: Schema.optional(ColoCode) }),
    SchemaTransformation.transform({
      decode: (q): { readonly colo?: string | undefined } => ({ colo: blank(q.colo) }),
      encode: (i) => i,
    }),
  ),
)
type Input = typeof Params.Type

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

const run = Effect.fnUntraced(function*(input: Input) {
  const visitor = yield* Tool.Visitor
  const cf = CfData.decodeCf(visitor.cf)
  const servedBy = CfData.cfString(cf, "colo").pipe(Option.map((s) => s.toUpperCase()))

  // A looked-up colo must exist; the serving one may be missing from the list.
  const looked = yield* Effect.transposeOption(Option.map(Option.fromNullishOr(input.colo), (code) =>
    Option.match(findColo(code), {
      onSome: Effect.succeed,
      onNone: () => Effect.fail(new Tool.InputError({ message: `unknown colo ${code}` })),
    })))
  const colo = Option.orElse(looked, () => Option.flatMap(servedBy, findColo))

  const str = (key: CfData.CfKey) => Option.getOrUndefined(CfData.cfString(cf, key))
  const lat = CfData.cfNumber(cf, "latitude")
  const lon = CfData.cfNumber(cf, "longitude")
  const country = str("country")
  const location = Option.map(cf, (): VisitorLocation => ({
    city: str("city"),
    region: str("region"),
    country,
    countryName: country !== undefined ? CfData.countryName(country) : undefined,
    continent: str("continent"),
    lat: Option.getOrUndefined(lat),
    lon: Option.getOrUndefined(lon),
  }))
  const here = Option.zipWith(lat, lon, (lat, lon): Point => ({ lat, lon }))
  const distance = Option.zipWith(Option.flatMap(colo, pointOf), here, (a, b) => Math.round(distanceKm(a, b)))

  return {
    servedBy: Option.getOrNull(servedBy),
    colo: Option.getOrNull(colo),
    serving: Option.isSome(colo) && Option.contains(servedBy, colo.value.code),
    visitor: Option.getOrNull(location),
    distanceKm: Option.getOrNull(distance),
  } satisfies Result
})

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
  params: Params,
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
