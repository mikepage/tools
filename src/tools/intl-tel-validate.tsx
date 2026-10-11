// Phone number validator: is a number valid, which country and type is it,
// and how is it written. libphonenumber-js with its full metadata.

import { Effect, Option, Schema, SchemaTransformation } from "effect"
import { type CountryCode, getCountries, parsePhoneNumberFromString, validatePhoneNumberLength } from "libphonenumber-js/max"
import { Check, Field, KeyValue, Select, Status } from "../app/ui.tsx"
import * as Tool from "./Tool.ts"

// libphonenumber's number types, as people read them.
const TYPE_LABELS: Readonly<Record<string, string>> = {
  FIXED_LINE: "Fixed line",
  MOBILE: "Mobile",
  FIXED_LINE_OR_MOBILE: "Fixed line or mobile",
  TOLL_FREE: "Toll free",
  PREMIUM_RATE: "Premium rate",
  SHARED_COST: "Shared cost",
  VOIP: "VoIP",
  PERSONAL_NUMBER: "Personal number",
  PAGER: "Pager",
  UAN: "UAN",
  VOICEMAIL: "Voicemail",
}

// Why a number that does not parse is invalid.
const LENGTH_ERRORS: Readonly<Record<string, string>> = {
  INVALID_COUNTRY: "Invalid country code",
  TOO_SHORT: "Number too short",
  TOO_LONG: "Number too long",
  NOT_A_NUMBER: "Not a number",
  INVALID_LENGTH: "Invalid length",
}

export const NUMBER_TYPES = ["any", "mobile", "fixed_line"] as const
export type NumberType = (typeof NUMBER_TYPES)[number]

const COUNTRIES = new Set<string>(getCountries())
const regionName = new Intl.DisplayNames(["en"], { type: "region" })
export const countryName = (cc: string): string => regionName.of(cc) ?? cc

// For the country select, by name.
const COUNTRY_OPTIONS: ReadonlyArray<readonly [string, string]> = [...COUNTRIES]
  .map((cc) => [cc, `${countryName(cc)} (${cc})`] as const)
  .sort((a, b) => a[1].localeCompare(b[1]))

// --- Input ----------------------------------------------------------------------

const blank = (s: string | undefined) => (s === undefined || s.trim() === "" ? undefined : s.trim())

// `country=nl` works as well as `country=NL`, and must be a country libphonenumber knows.
const Country = Schema.String.pipe(
  Schema.decode(SchemaTransformation.toUpperCase()),
  Schema.check(Schema.makeFilter((cc: string) => COUNTRIES.has(cc) || `Unknown country ${cc}`)),
)

// What an HTML checkbox or a script would send.
const Flag = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Boolean,
    SchemaTransformation.transform({ decode: (s) => /^(1|on|true|yes)$/i.test(s), encode: String }),
  ),
)

const Params = Schema.Struct({
  number: Schema.optional(Schema.String),
  country: Schema.optional(Schema.String),
  strict: Schema.optional(Schema.String),
  type: Schema.optional(Schema.String),
}).pipe(
  Schema.decodeTo(
    Schema.Struct({
      number: Schema.String.check(Schema.isNonEmpty({ message: "Please enter a phone number" })),
      country: Schema.optionalKey(Country),
      strict: Flag,
      type: Schema.String.pipe(Schema.decodeTo(Schema.Literals(NUMBER_TYPES))),
    }),
    SchemaTransformation.transform({
      decode: (q) => {
        const country = blank(q.country)
        return {
          number: blank(q.number) ?? "",
          ...(country === undefined ? {} : { country }),
          strict: blank(q.strict) ?? "off",
          type: blank(q.type) ?? "any",
        }
      },
      encode: (i) => i,
    }),
  ),
)
type Input = typeof Params.Type

// --- Result ---------------------------------------------------------------------

export interface Result {
  readonly valid: boolean
  readonly error?: string
  readonly country?: string
  readonly countryName?: string
  readonly numberType?: string
  readonly national?: string
  readonly international?: string
  readonly e164?: string
  /** The visitor's country, used for a number without `+` when no country was given. */
  readonly assumedCountry?: string
}

const withCountry = (cc: string | undefined) => (cc ? { country: cc, countryName: countryName(cc) } : {})

/** Validates a number. Synchronous and total: an invalid number is a result, not an error. */
export const validate = (
  number: string,
  country: CountryCode | undefined,
  strict: boolean,
  type: NumberType,
): Result => {
  // Strict mode mirrors intl-tel-input's: only characters a phone number can contain.
  if (strict && !/^\+?[\d\s().-]+$/.test(number)) return { valid: false, error: "Not a number" }
  const phone = parsePhoneNumberFromString(number, country)
  if (!phone || !phone.isValid()) {
    const reason = validatePhoneNumberLength(number, country)
    return {
      valid: false,
      error: (reason && LENGTH_ERRORS[reason]) || "Invalid number",
      ...withCountry(phone?.country ?? country),
    }
  }
  const raw = phone.getType()
  const label = (raw && TYPE_LABELS[raw]) || "Unknown"
  const result: Result = {
    valid: true,
    ...withCountry(phone.country),
    numberType: label,
    national: phone.formatNational(),
    international: phone.formatInternational(),
    e164: phone.number,
  }
  const mobile = raw === "MOBILE" || raw === "FIXED_LINE_OR_MOBILE"
  const fixed = raw === "FIXED_LINE" || raw === "FIXED_LINE_OR_MOBILE"
  if (type === "mobile" && !mobile) return { ...result, valid: false, error: `Expected mobile number, got ${label}` }
  if (type === "fixed_line" && !fixed) return { ...result, valid: false, error: `Expected fixed line number, got ${label}` }
  return result
}

// The visitor's country from Cloudflare, when libphonenumber knows it.
const visitorCountry = Effect.gen(function*() {
  const visitor = yield* Tool.Visitor
  return Option.flatMap(visitor.cf, (cf) => {
    const cc = cf["country"]
    return typeof cc === "string" && COUNTRIES.has(cc.toUpperCase()) ? Option.some(cc.toUpperCase()) : Option.none()
  })
})

export const check = Effect.fnUntraced(function*(input: Input) {
  const assumed = input.country === undefined && !input.number.startsWith("+")
    ? Option.getOrUndefined(yield* visitorCountry)
    : undefined
  const country = (input.country ?? assumed) as CountryCode | undefined
  const result = validate(input.number, country, input.strict, input.type)
  return (assumed ? { ...result, assumedCountry: assumed } : result) satisfies Result
})

// --- Views ----------------------------------------------------------------------

const Form = ({ query }: { readonly query: Tool.Query }) => (
  <>
    <Field label="Phone number" name="number" value={query["number"]} placeholder="+31 6 12345678" grow autofocus />
    <Select
      label="Country"
      name="country"
      value={query["country"]?.toUpperCase() ?? ""}
      options={[["", "From +code or location"], ...COUNTRY_OPTIONS]}
    />
    <Select
      label="Must be"
      name="type"
      value={query["type"] ?? "any"}
      options={[["any", "Any type"], ["mobile", "Mobile"], ["fixed_line", "Fixed line"]]}
    />
    <Check label="Strict" name="strict" checked={/^(1|on|true|yes)$/i.test(query["strict"] ?? "")} />
  </>
)

const headline = (r: Result): string => {
  const type = r.numberType ? `${r.numberType.toLowerCase()} number` : "number"
  return r.countryName ? `Valid ${type} from ${r.countryName}` : `Valid ${type}`
}

const Result = ({ result }: { readonly result: Result }) => (
  <>
    <p>
      {result.valid
        ? <Status level="ok">{headline(result)}</Status>
        : <Status level="bad">{result.error ?? "Invalid number"}</Status>}
    </p>
    {result.assumedCountry
      ? <p class="muted">Read as a number from {countryName(result.assumedCountry)}, where you are. Pick a country to change that.</p>
      : null}
    <KeyValue
      rows={[
        ["Country", result.country ? `${result.countryName} (${result.country})` : undefined],
        ["Type", result.numberType],
        ["International", result.international],
        ["National", result.national],
        ["E.164", result.e164 ? <a href={`tel:${result.e164}`}><code>{result.e164}</code></a> : undefined],
      ]}
    />
  </>
)

export const intlTelValidate = Tool.make<Input, Result>({
  slug: "intl-tel-validate",
  title: "Phone number validator",
  summary: "Check a phone number: valid or not, which country and type, and its national, international and E.164 formats.",
  category: "Web",
  params: Params,
  run: check,
  Form,
  Result,
  examples: [
    { label: "+31 6 12345678", query: "number=%2B31612345678" },
    { label: "020 123 4567 in NL, must be mobile", query: "number=0201234567&country=NL&type=mobile" },
    { label: "+1 650 253 0000", query: "number=%2B16502530000" },
  ],
})
