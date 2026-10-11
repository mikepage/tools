// Cloudflare's `request.cf`, as the visitor tools read it. It is untrusted
// and missing outside the edge (wrangler dev without a remote, plain tests),
// so it is read as a plain record and every field in it is optional.

/** The Visitor's `cf`: undefined outside the edge. */
export type Cf = Readonly<Record<string, unknown>> | undefined

/** The fields the visitor tools read. */
export type CfKey =
  | "colo"
  | "city"
  | "region"
  | "regionCode"
  | "country"
  | "continent"
  | "isEUCountry"
  | "postalCode"
  | "metroCode"
  | "latitude"
  | "longitude"
  | "timezone"
  | "asn"
  | "asOrganization"
  | "httpProtocol"
  | "tlsVersion"
  | "tlsCipher"
  | "clientTcpRtt"

// Cloudflare sends some fields as strings ("52.37"), some as numbers (asn)
// and some as either, depending on the runtime version. Anything else
// (objects, arrays) is ignored.
/** One field as a non-empty string; undefined when missing, empty or not a scalar. */
export const cfString = (cf: Cf, key: CfKey): string | undefined => {
  const value = cf?.[key]
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return undefined
  const s = String(value)
  return s === "" ? undefined : s
}

/** One field as a finite number (coordinates arrive as strings). */
export const cfNumber = (cf: Cf, key: CfKey): number | undefined => {
  const s = cfString(cf, key)
  if (s === undefined) return undefined
  const n = Number(s)
  return Number.isFinite(n) ? n : undefined
}

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
