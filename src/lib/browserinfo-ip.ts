// IP literals and their reverse-DNS names, plus a PTR lookup over DoH.

import { Effect, Option } from "effect"
import * as Doh from "./doh.ts"

/** Four decimal octets 0-255 without leading zeros, so 010.1.1.1 is rejected rather than read as octal. */
export const isIpv4 = (ip: string): boolean => {
  const parts = ip.split(".")
  return parts.length === 4 && parts.every((p) => /^(0|[1-9]\d{0,2})$/.test(p) && Number(p) <= 255)
}

// Eight zero-padded groups, or None when the input is not IPv6.
const expandGroups = (input: string): Option.Option<string> => {
  const parts = input.split("::")
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

/**
 * An IPv6 literal in full form (eight 4-digit groups), including an embedded
 * IPv4 tail like ::ffff:192.0.2.1. Zone ids (fe80::1%eth0) are rejected.
 */
export const expandIpv6 = (ip: string): Option.Option<string> => {
  if (!ip.includes(":") || ip.includes("%")) return Option.none()
  const tail = ip.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/)
  if (!tail) return expandGroups(ip)
  if (!isIpv4(tail[2]!)) return Option.none()
  const [a, b, c, d] = tail[2]!.split(".").map(Number) as [number, number, number, number]
  const hex = (hi: number, lo: number) => ((hi << 8) | lo).toString(16)
  return expandGroups(`${tail[1]}${hex(a, b)}:${hex(c, d)}`)
}

/** 4.3.2.1.in-addr.arpa, or the 32 reversed nibbles under ip6.arpa. None when it is not an IP literal. */
export const reverseName = (input: string): Option.Option<string> => {
  const ip = input.trim()
  if (isIpv4(ip)) return Option.some(`${ip.split(".").reverse().join(".")}.in-addr.arpa`)
  return Option.map(expandIpv6(ip), (full) => `${full.replace(/:/g, "").split("").reverse().join(".")}.ip6.arpa`)
}

/** Private, CGNAT, link-local, loopback, multicast and unique-local addresses: no public PTR worth asking for. */
export const isPrivate = (ip: string): boolean => {
  if (isIpv4(ip)) {
    const [a, b] = ip.split(".").map(Number) as [number, number]
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224
  }
  return Option.match(expandIpv6(ip), {
    onNone: () => true,
    onSome: (full) =>
      full === "0000:0000:0000:0000:0000:0000:0000:0000" || full === "0000:0000:0000:0000:0000:0000:0000:0001" ||
      /^fe[89ab]/.test(full) || /^f[cd]/.test(full) || full.startsWith("0000:0000:0000:0000:0000:ffff:"),
  })
}

export interface Ptr {
  readonly ip: string
  readonly name: string
  /** Every PTR target, trailing dot stripped; usually zero or one. */
  readonly hostnames: ReadonlyArray<string>
  readonly hostname: string | null
}

/** The PTR record of an address whose reverse name is `name`. */
export const ptr = Effect.fnUntraced(function*(ip: string, name: string) {
  const { response } = yield* Doh.query(name, "PTR")
  const hostnames = Doh.answersOf(response, 12).map((a) => Doh.noDot(a.data))
  return { ip, name, hostnames, hostname: hostnames[0] ?? null } satisfies Ptr
})
