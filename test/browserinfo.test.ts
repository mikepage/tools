import { ManagedRuntime, Option } from "effect"
import { FetchHttpClient } from "effect/http"
import { afterAll, describe, expect, it } from "vitest"
import { makeHandler } from "../src/app/handler.ts"
import { isPrivate, reverseName } from "../src/lib/browserinfo-ip.ts"
import { browserinfo, parseUserAgent } from "../src/tools/browserinfo.tsx"

const runtime = ManagedRuntime.make(FetchHttpClient.layer)
const handle = makeHandler([browserinfo])
afterAll(() => runtime.dispose())

const get = async (path: string, headers: Record<string, string> = {}, cf?: Record<string, unknown>) => {
  const request = Object.assign(new Request(`https://tools.test${path}`, { headers }), cf ? { cf } : {})
  const response = await runtime.runPromise(handle(request))
  return { status: response.status, text: await response.text() }
}
const json = async (path: string, headers: Record<string, string> = {}) => JSON.parse((await get(path, headers)).text)

describe("browserinfo", () => {
  it("reports IP and headers, skipping PTR for a private address", async () => {
    const body = await json("/browserinfo/api", {
      "cf-connecting-ip": "192.168.1.10",
      "user-agent": "flareosaur-check",
      "accept-language": "nl-NL",
    })
    expect(body).toMatchObject({
      ip: "192.168.1.10",
      version: 4,
      ptr: null,
      headers: { "user-agent": "flareosaur-check", "accept-language": "nl-NL" },
    })
  })

  it("reads Sec-CH-UA, skipping GREASE and preferring a real brand", async () => {
    const body = await json("/browserinfo/api?ptr=false", {
      "sec-ch-ua": `"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"`,
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": `"macOS"`,
    })
    expect(body.clientHints).toMatchObject({ browser: "Google Chrome 128", platform: "macOS", mobile: false })
  })

  it("prefers the full version list", async () => {
    const body = await json("/browserinfo/api?ptr=false", {
      "sec-ch-ua-full-version-list": `"Not A(Brand";v="8.0.0.0", "Chromium";v="132.0.6834.83"`,
      "sec-ch-ua-mobile": "?1",
    })
    expect(body.clientHints).toMatchObject({ browser: "Chromium 132.0.6834.83", mobile: true })
  })

  it("rejects a bad ptr flag with 400", async () => {
    const { status, text } = await get("/browserinfo/api?ptr=maybe")
    expect(status).toBe(400)
    expect(JSON.parse(text)).toHaveProperty("error")
  })

  it("looks up the PTR of a public IP", async () => {
    const body = await json("/browserinfo/api?ptr=true", { "cf-connecting-ip": "1.1.1.1" })
    expect(body.ptr).toMatchObject({ name: "1.1.1.1.in-addr.arpa", hostname: "one.one.one.one" })
  })

  it("builds reverse names and rejects non-addresses", () => {
    expect(Option.getOrNull(reverseName("2606:4700:4700::1111"))).toBe(
      "1.1.1.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.7.4.0.0.7.4.6.0.6.2.ip6.arpa",
    )
    expect(Option.getOrNull(reverseName("::ffff:192.0.2.1"))).toBe(
      "1.0.2.0.0.0.0.c.f.f.f.f.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.ip6.arpa",
    )
    for (const bad of ["example.com", "300.1.1.1", "01.1.1.1", "2001:db8:::1", "fe80::1%eth0", "::ffff:999.0.0.1", ""]) {
      expect(Option.isNone(reverseName(bad)), bad).toBe(true)
    }
    expect(isPrivate("100.64.0.1")).toBe(true)
    expect(isPrivate("fd00::1")).toBe(true)
    expect(isPrivate("8.8.8.8")).toBe(false)
  })

  it("falls back to the User-Agent for browsers without Client Hints", () => {
    expect(parseUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:131.0) Gecko/20100101 Firefox/131.0"))
      .toEqual({ browser: "Firefox 131", os: "macOS" })
    expect(
      parseUserAgent(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      ),
    ).toEqual({ browser: "Safari 18", os: "iOS" })
  })

  it("renders the page with cf data", async () => {
    const { status, text } = await get(
      "/browserinfo?ptr=off",
      { "cf-connecting-ip": "203.0.113.5", "user-agent": "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0" },
      { colo: "AMS", country: "NL", city: "Amsterdam", httpProtocol: "HTTP/3", tlsVersion: "TLSv1.3", asn: 1136 },
    )
    expect(status).toBe(200)
    expect(text).toContain("Firefox 131")
    expect(text).toContain("HTTP/3")
    expect(text).toContain("Netherlands (NL)")
    expect(text).toContain("not looked up")
    expect(text).toContain("None received")
  })
})
