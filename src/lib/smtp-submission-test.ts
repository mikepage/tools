// Pure helpers of the SMTP submission test: the address classifier of its SSRF
// guard and the EHLO parser. Kept apart from the tool, which imports
// `cloudflare:sockets`, so plain Node tests can load them.

export const isPrivateIPv4 = (ip: string): boolean => {
  const p = ip.split(".").map(Number)
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const [a = 0, b = 0, c = 0] = p
  return a === 0 || a === 10 || a === 127 || // this host, private, loopback
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 168) || // private
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // IETF protocol assignments, TEST-NET-1
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3
    a >= 224 // multicast, reserved, broadcast
}

export const isPrivateIPv6 = (ip: string): boolean => {
  const h = ip.toLowerCase()
  if (h === "::1" || h === "::") return true
  if (/^fe[89ab]/.test(h)) return true // fe80::/10 link-local
  if (h.startsWith("fc") || h.startsWith("fd")) return true // fc00::/7 unique local
  if (h.startsWith("ff")) return true // multicast
  if (h.startsWith("2001:db8:") || h.startsWith("2001:0db8:")) return true // documentation
  const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/) // IPv4-mapped
  return mapped ? isPrivateIPv4(mapped[1]!) : false
}

export const isPrivateAddress = (ip: string): boolean => (ip.includes(":") ? isPrivateIPv6(ip) : isPrivateIPv4(ip))

/** The first EHLO line is "250-hostname greeting"; the rest are capabilities. */
export const capabilitiesOf = (lines: ReadonlyArray<string>): Array<string> =>
  lines.slice(1).filter((l) => l.startsWith("250")).map((l) => l.slice(4).trim()).filter(Boolean)
