import { ManagedRuntime } from "effect"
import { FetchHttpClient } from "effect/http"
import { afterAll, describe, expect, it } from "vitest"
import { makeHandler } from "../src/app/handler.ts"
import { rdapLookup } from "../src/tools/rdap-lookup.tsx"

const runtime = ManagedRuntime.make(FetchHttpClient.layer)
const handle = makeHandler([rdapLookup])
afterAll(() => runtime.dispose())

const get = async (path: string) => {
  const response = await runtime.runPromise(handle(new Request(`https://tools.test${path}`)))
  return { status: response.status, text: await response.text() }
}

describe("rdap-lookup", () => {
  it("summarises cloudflare.com from Verisign", async () => {
    const { status, text } = await get("/rdap-lookup/api?domain=cloudflare.com")
    expect(status).toBe(200)
    const body = JSON.parse(text)
    expect(body).toMatchObject({ domain: "cloudflare.com", rdapServer: "https://rdap.verisign.com/com/v1/" })
    expect(body.handle).toEqual(expect.any(String))
    expect(body.ianaId).toEqual(expect.any(String))
    expect(body.events.registration).toEqual(expect.any(String))
    expect(body.expiresInDays).toBeGreaterThan(0)
    expect(body.nameservers[0]).toHaveProperty("ipv4")
    expect(body.dnssec).toHaveProperty("delegationSigned")
    expect(body.queryTimeMs).toEqual(expect.any(Number))
    expect(body).not.toHaveProperty("raw")
  })

  it("cleans a pasted URL and adds the raw response with raw=1", async () => {
    const body = JSON.parse((await get(`/rdap-lookup/api?domain=${encodeURIComponent("https://Cloudflare.com/")}&raw=1`)).text)
    expect(body.domain).toBe("cloudflare.com")
    expect(body.raw).toMatchObject({ objectClassName: "domain" })
  })

  it("rejects bad input with 400", async () => {
    for (const q of ["", "domain=", "domain=not%20a%20domain"]) {
      const { status, text } = await get(`/rdap-lookup/api?${q}`)
      expect(status, q).toBe(400)
      expect(JSON.parse(text)).toHaveProperty("error")
    }
  })

  it("answers 502 for a TLD without RDAP and an unregistered domain", async () => {
    const tld = await get("/rdap-lookup/api?domain=example.invalidtld")
    expect(tld.status).toBe(502)
    expect(JSON.parse(tld.text).error).toContain('TLD ".invalidtld" is not supported by RDAP')
    const missing = await get("/rdap-lookup/api?domain=this-domain-should-not-exist-mikepage-7f3a9.com")
    expect(missing.status).toBe(502)
    expect(JSON.parse(missing.text).error).toContain("not found in RDAP registry")
  })

  it("renders registrar, nameservers and DNSSEC in the page", async () => {
    const { status, text } = await get("/rdap-lookup?domain=cloudflare.com")
    expect(status).toBe(200)
    expect(text).toContain("Nameservers")
    expect(text).toContain("cloudflare.com</code>")
    expect(text).toContain("rdap.verisign.com")
  })
})
