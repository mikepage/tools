// Cloudflare's `request.cf`, as the visitor tools read it. It is untrusted
// and missing outside the edge (wrangler dev without a remote, Node tests),
// so it decodes into an Option, and every field in it is optional.

import { Option, Schema } from "effect"

// Cloudflare sends some fields as strings ("52.37"), some as numbers (asn)
// and some as either, depending on the runtime version.
const Scalar = Schema.Union([Schema.String, Schema.Number, Schema.Boolean])

export const Cf = Schema.Struct({
  colo: Schema.optional(Scalar),
  city: Schema.optional(Scalar),
  region: Schema.optional(Scalar),
  regionCode: Schema.optional(Scalar),
  country: Schema.optional(Scalar),
  continent: Schema.optional(Scalar),
  isEUCountry: Schema.optional(Scalar),
  postalCode: Schema.optional(Scalar),
  metroCode: Schema.optional(Scalar),
  latitude: Schema.optional(Scalar),
  longitude: Schema.optional(Scalar),
  timezone: Schema.optional(Scalar),
  asn: Schema.optional(Scalar),
  asOrganization: Schema.optional(Scalar),
  httpProtocol: Schema.optional(Scalar),
  tlsVersion: Schema.optional(Scalar),
  tlsCipher: Schema.optional(Scalar),
  clientTcpRtt: Schema.optional(Scalar),
})
export type Cf = typeof Cf.Type
export type CfKey = keyof Cf

/** Decodes the Visitor's `cf`; None when it is missing or not an object of scalars. */
export const decodeCf = (cf: Option.Option<unknown>): Option.Option<Cf> =>
  Option.flatMap(cf, Schema.decodeUnknownOption(Cf))

/** One field as a non-empty string. */
export const cfString = (cf: Option.Option<Cf>, key: CfKey): Option.Option<string> =>
  cf.pipe(
    Option.flatMap((c) => Option.fromNullishOr(c[key])),
    Option.map(String),
    Option.filter((s) => s !== ""),
  )

/** One field as a finite number (coordinates arrive as strings). */
export const cfNumber = (cf: Option.Option<Cf>, key: CfKey): Option.Option<number> =>
  cfString(cf, key).pipe(Option.map(Number), Option.filter(Number.isFinite))

/** 4 or 6, from the shape of the address. */
export const ipVersion = (ip: string): 4 | 6 => (ip.includes(":") ? 6 : 4)

const regionNames = new Intl.DisplayNames(["en"], { type: "region" })

/** "NL" -> "Netherlands"; the code itself when Intl does not know it. */
export const countryName = (cca2: string): string => {
  try {
    return regionNames.of(cca2.toUpperCase()) ?? cca2
  } catch {
    return cca2
  }
}
