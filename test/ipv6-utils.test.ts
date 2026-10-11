import { ManagedRuntime } from "effect"
import { FetchHttpClient } from "effect/http"
import { afterAll, describe, expect, it } from "vitest"
import { makeHandler } from "../src/app/handler.ts"
import { ipv6Utils } from "../src/tools/ipv6-utils.tsx"

const runtime = ManagedRuntime.make(FetchHttpClient.layer)
const handle = makeHandler([ipv6Utils])
afterAll(() => runtime.dispose())

const get = async (path: string, headers: Record<string, string> = {}) => {
  const response = await runtime.runPromise(handle(new Request(`https://tools.test${path}`, { headers })))
  return { status: response.status, text: await response.text() }
}
const api = async (query: string, headers: Record<string, string> = {}) => {
  const { status, text } = await get(`/ipv6-utils/api?${query}`, headers)
  return { status, body: JSON.parse(text) }
}

describe("ipv6-utils", () => {
  it("expands, compresses and checks a range", async () => {
    const { status, body } = await api("address=2001:db8::1&prefix=64&cidr=2001:db8::/32")
    expect(status).toBe(200)
    expect(body).toMatchObject({
      fullAddress: "2001:0db8:0000:0000:0000:0000:0000:0001",
      compressedAddress: "2001:db8::1",
      kind: "Documentation",
      inRange: true,
    })
  })

  it("reports an address outside the range", async () => {
    expect((await api("address=2001:db9::1&cidr=2001:db8::/32")).body.inRange).toBe(false)
  })

  it("keeps the details when the range is not CIDR", async () => {
    const { status, body } = await api("address=2001:db8::1&cidr=2001:db8::")
    expect(status).toBe(200)
    expect(body).toMatchObject({ compressedAddress: "2001:db8::1", prefixLength: 64, cidrError: "Use CIDR notation: address/prefix" })
    expect(body).not.toHaveProperty("inRange")
  })

  it("works out the network for a prefix", async () => {
    expect((await api("address=2001:db8::1&prefix=48")).body).toMatchObject({ networkAddress: "2001:db8::", prefixLength: 48 })
    expect((await api("address=2001:db8:1:2:3:4:5:6")).body).toMatchObject({
      networkAddress: "2001:db8:1:2::",
      lastAddress: "2001:db8:1:2:ffff:ffff:ffff:ffff",
      totalAddresses: "2^64",
    })
    expect((await api("address=2001:db8::1&prefix=120")).body).toMatchObject({ lastAddress: "2001:db8::ff", totalAddresses: "256" })
  })

  it("compresses per RFC 5952", async () => {
    expect((await api("address=2001:0db8:0000:0001:0000:0000:0000:0001")).body.compressedAddress).toBe("2001:db8:0:1::1")
    expect((await api("address=::")).body).toMatchObject({
      fullAddress: "0000:0000:0000:0000:0000:0000:0000:0000",
      compressedAddress: "::",
      kind: "Unspecified",
    })
  })

  it("rejects bad input with 400", async () => {
    for (const [q, message] of [
      ["address=1::2::3", "invalid IPv6 address"],
      ["address=192.168.0.1", "invalid IPv6 address"],
      ["address=1:2:3:4:5:6:7:8::", "invalid IPv6 address"],
      ["address=2001:db8::1&prefix=129", "prefix must be an integer 0-128"],
      ["", "address is required"],
    ] as const) {
      const { status, body } = await api(q)
      expect(status, q).toBe(400)
      expect(body.error, q).toContain(message)
    }
  })

  it("uses the visitor's address with use=mine", async () => {
    expect((await api("use=mine", { "cf-connecting-ip": "2a01:4f8::7" })).body.networkAddress).toBe("2a01:4f8::")
    const v4 = await api("use=mine", { "cf-connecting-ip": "192.0.2.1" })
    expect(v4.status).toBe(400)
    expect(v4.body.error).toContain("No IPv6 address found")
  })

  it("renders the network in the page", async () => {
    const { status, text } = await get("/ipv6-utils?address=2001:db8::1&prefix=64&cidr=2001:db8::/32")
    expect(status).toBe(200)
    expect(text).toContain("First address")
    expect(text).toContain("2001:db8::/64")
    expect(text).toContain("Inside")
  })
})
