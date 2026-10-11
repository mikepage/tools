// IPv6 utils: expand and compress an address, work out its network for a
// prefix length, and check it against a CIDR range. Pure 128-bit BigInt math.

import { Effect, Option, Result as R, Schema, SchemaTransformation } from "effect"
import { Field, KeyValue, Status, Summary } from "../app/ui.tsx"
import * as Tool from "./Tool.ts"

// --- Pure helpers ---------------------------------------------------------------

/** Eight zero-padded lowercase groups, or None when the input is not IPv6. */
export const expandIpv6 = (input: string): Option.Option<string> => {
  const parts = input.trim().split("::")
  if (parts.length > 2) return Option.none()
  let groups: Array<string>
  if (parts.length === 2) {
    const left = parts[0] ? parts[0].split(":") : []
    const right = parts[1] ? parts[1].split(":") : []
    const missing = 8 - left.length - right.length
    if (missing < 1) return Option.none()
    groups = [...left, ...Array<string>(missing).fill("0"), ...right]
  } else {
    groups = parts[0]!.split(":")
  }
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return Option.none()
  return Option.some(groups.map((g) => g.padStart(4, "0").toLowerCase()).join(":"))
}

/** RFC 5952: strip leading zeros, collapse the longest run (two or more) of zero groups to `::`. */
export const compressIpv6 = (full: string): string => {
  const groups = full.split(":").map((g) => g.replace(/^0+/, "") || "0")
  let best = -1
  let bestLen = 0
  for (let i = 0; i < groups.length;) {
    if (groups[i] !== "0") {
      i++
      continue
    }
    let j = i
    while (j < groups.length && groups[j] === "0") j++
    if (j - i > bestLen) [best, bestLen] = [i, j - i]
    i = j
  }
  if (bestLen < 2) return groups.join(":")
  return `${groups.slice(0, best).join(":")}::${groups.slice(best + bestLen).join(":")}`
}

const toBigInt = (full: string): bigint => full.split(":").reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g, 16)), 0n)

const fromBigInt = (value: bigint): string => {
  const groups: Array<string> = []
  for (let i = 0; i < 8; i++, value >>= 16n) groups.unshift((value & 0xffffn).toString(16).padStart(4, "0"))
  return groups.join(":")
}

const networkOf = (full: string, prefix: number): bigint =>
  toBigInt(full) & (((1n << BigInt(prefix)) - 1n) << BigInt(128 - prefix))

// Well-known ranges, most specific first.
const KINDS: ReadonlyArray<readonly [cidr: string, kind: string]> = [
  ["::/128", "Unspecified"],
  ["::1/128", "Loopback"],
  ["::ffff:0:0/96", "IPv4-mapped"],
  ["64:ff9b::/96", "NAT64"],
  ["2001:db8::/32", "Documentation"],
  ["2001::/32", "Teredo"],
  ["2002::/16", "6to4"],
  ["fc00::/7", "Unique local (private)"],
  ["fe80::/10", "Link-local"],
  ["ff00::/8", "Multicast"],
  ["2000::/3", "Global unicast"],
]

/** What kind of address this is, from the well-known ranges. */
export const kindOf = (full: string): string => {
  const value = toBigInt(full)
  for (const [cidr, kind] of KINDS) {
    const [range = "", bits = "0"] = cidr.split("/")
    const prefix = Number(bits)
    if (networkOf(fromBigInt(value), prefix) === networkOf(Option.getOrThrow(expandIpv6(range)), prefix)) return kind
  }
  return "Reserved"
}

export interface Details {
  readonly fullAddress: string
  readonly compressedAddress: string
  readonly kind: string
  readonly networkAddress: string
  readonly prefixLength: number
  readonly firstAddress: string
  readonly lastAddress: string
  /** A count, or `2^n` above a million. */
  readonly totalAddresses: string
}

/** The address and its enclosing network. Takes an expanded address, so it cannot fail. */
export const describeIpv6 = (full: string, prefix: number): Details => {
  const hostBits = 128 - prefix
  const network = networkOf(full, prefix)
  const total = 1n << BigInt(hostBits)
  return {
    fullAddress: full,
    compressedAddress: compressIpv6(full),
    kind: kindOf(full),
    networkAddress: compressIpv6(fromBigInt(network)),
    prefixLength: prefix,
    firstAddress: compressIpv6(fromBigInt(network)),
    lastAddress: compressIpv6(fromBigInt(network | (total - 1n))),
    totalAddresses: total > 1_000_000n ? `2^${hostBits}` : total.toString(),
  }
}

/** Is `full` inside `cidr` (e.g. 2001:db8::/32)? A bad range is a failure with a message. */
export const inCidr = (full: string, cidr: string): R.Result<boolean, string> => {
  const [range = "", prefixText] = cidr.trim().split("/")
  if (!prefixText) return R.fail("Use CIDR notation: address/prefix")
  const prefix = Number(prefixText)
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 128) return R.fail("Prefix length must be between 0 and 128")
  return Option.match(expandIpv6(range), {
    onNone: () => R.fail("Invalid IPv6 range address"),
    onSome: (r) => R.succeed(networkOf(full, prefix) === networkOf(r, prefix)),
  })
}

// --- Input ----------------------------------------------------------------------

const blank = (s: string | undefined) => (s === undefined || s.trim() === "" ? undefined : s.trim())

const Ipv6 = Schema.String.pipe(
  Schema.decode(SchemaTransformation.transform({ decode: (s) => Option.getOrElse(expandIpv6(s), () => s), encode: (s) => s })),
  Schema.check(Schema.makeFilter((s: string) => Option.isSome(expandIpv6(s)), { message: "invalid IPv6 address" })),
)

const Prefix = Schema.FiniteFromString.check(
  Schema.makeFilter((n: number) => Number.isInteger(n) && n >= 0 && n <= 128, { message: "prefix must be an integer 0-128" }),
)

const Params = Schema.Struct({
  address: Schema.optional(Schema.String),
  prefix: Schema.optional(Schema.String),
  cidr: Schema.optional(Schema.String),
  use: Schema.optional(Schema.String),
}).pipe(
  Schema.decodeTo(
    Schema.Struct({
      address: Schema.optionalKey(Ipv6),
      prefix: Prefix,
      cidr: Schema.optionalKey(Schema.String),
      // use=mine takes the address the request came from.
      mine: Schema.Boolean,
    }),
    SchemaTransformation.transform({
      decode: (q) => {
        const address = blank(q.address)
        const cidr = blank(q.cidr)
        return {
          ...(address === undefined ? {} : { address }),
          prefix: blank(q.prefix) ?? "64",
          ...(cidr === undefined ? {} : { cidr }),
          mine: blank(q.use) === "mine",
        }
      },
      encode: ({ mine, ...rest }) => (mine ? { ...rest, use: "mine" } : rest),
    }),
  ),
)
type Input = typeof Params.Type

// --- Result ---------------------------------------------------------------------

export interface Result extends Details {
  /** The range asked about, with the answer or why it could not be checked. */
  readonly cidr?: string
  readonly inRange?: boolean
  readonly cidrError?: string
}

// The visitor's own address, which must be IPv6.
const visitorAddress = Effect.gen(function*() {
  const visitor = yield* Tool.Visitor
  return yield* Option.match(Option.flatMap(visitor.ip, expandIpv6), {
    onSome: Effect.succeed,
    onNone: () =>
      Effect.fail(
        new Tool.InputError({
          message: Option.match(visitor.ip, {
            onSome: (ip) => `No IPv6 address found: you are connecting over IPv4 (${ip}).`,
            onNone: () => "No IPv6 address found.",
          }),
        }),
      ),
  })
})

export const analyze = Effect.fnUntraced(function*(input: Input) {
  const address = input.mine
    ? yield* visitorAddress
    : input.address ?? (yield* new Tool.InputError({ message: "address is required" }))
  const details = describeIpv6(address, input.prefix)
  if (input.cidr === undefined) return details satisfies Result
  const cidr = input.cidr
  return R.match(inCidr(address, cidr), {
    onSuccess: (inRange): Result => ({ ...details, cidr, inRange }),
    onFailure: (cidrError): Result => ({ ...details, cidr, cidrError }),
  })
})

// --- Views ----------------------------------------------------------------------

const Form = ({ query }: { readonly query: Tool.Query }) => (
  <>
    <Field label="IPv6 address" name="address" value={query["address"]} placeholder="2001:db8::1" grow autofocus />
    <Field label="Prefix" name="prefix" value={query["prefix"] ?? "64"} type="number" />
    <Field label="In range (optional)" name="cidr" value={query["cidr"]} placeholder="2001:db8::/32" />
  </>
)

const Count = ({ total }: { readonly total: string }) =>
  total.startsWith("2^") ? <>2<sup>{total.slice(2)}</sup></> : <>{Number(total).toLocaleString("en")}</>

const Range = ({ result }: { readonly result: Result }) => {
  if (result.cidr === undefined) return null
  if (result.cidrError !== undefined) return <p><Status level="bad">{result.cidrError}: <code>{result.cidr}</code></Status></p>
  return (
    <p>
      {result.inRange
        ? <Status level="ok">Inside <code>{result.cidr}</code></Status>
        : <Status level="warn">Outside <code>{result.cidr}</code></Status>}
    </p>
  )
}

const Result = ({ result, input }: { readonly result: Result; readonly input: Input }) => (
  <>
    <Summary
      items={[
        ["Address", result.compressedAddress],
        ["Type", result.kind],
        ...(input.mine ? [["Source", "your connection"] as const] : []),
      ]}
    />
    <Range result={result} />
    <h3>Address</h3>
    <KeyValue
      rows={[
        ["Compressed", <code>{result.compressedAddress}</code>],
        ["Expanded", <code>{result.fullAddress}</code>],
      ]}
    />
    <h3>Network /{result.prefixLength}</h3>
    <KeyValue
      rows={[
        ["Network", <code>{result.networkAddress}/{result.prefixLength}</code>],
        ["First address", <code>{result.firstAddress}</code>],
        ["Last address", <code>{result.lastAddress}</code>],
        ["Addresses", <Count total={result.totalAddresses} />],
      ]}
    />
  </>
)

export const ipv6Utils = Tool.make<Input, Result>({
  slug: "ipv6-utils",
  title: "IPv6 utils",
  summary: "Expand and compress an IPv6 address, find its network for a prefix length, and check it against a CIDR range.",
  category: "Network",
  params: Params,
  run: analyze,
  Form,
  Result,
  examples: [
    { label: "2001:db8::1 in 2001:db8::/32", query: "address=2001:db8::1&prefix=64&cidr=2001:db8::/32" },
    { label: "A /120", query: "address=2001:db8::1&prefix=120" },
    { label: "Your own address", query: "use=mine" },
  ],
})
