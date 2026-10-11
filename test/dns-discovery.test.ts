import { ManagedRuntime } from "effect"
import { FetchHttpClient } from "effect/http"
import { afterAll, describe, expect, it } from "vitest"
import { makeHandler } from "../src/app/handler.ts"
import { dnsDiscovery, subdomainsFromCerts } from "../src/tools/dns-discovery.tsx"

const runtime = ManagedRuntime.make(FetchHttpClient.layer)
const handle = makeHandler([dnsDiscovery])
afterAll(() => runtime.dispose())

const get = async (path: string) => {
  const response = await runtime.runPromise(handle(new Request(`https://tools.test${path}`)))
  return { status: response.status, text: await response.text() }
}
const api = async (query: string) => {
  const { status, text } = await get(`/dns-discovery/api?${query}`)
  expect(status, text).toBe(200)
  return JSON.parse(text)
}

describe("dns-discovery", () => {
  it("rejects bad input with 400", async () => {
    for (const q of ["", "domain=nope", "domain=example.com&resolver=quad9"]) {
      const { status, text } = await get(`/dns-discovery/api?${q}`)
      expect(status, q).toBe(400)
      expect(JSON.parse(text)).toHaveProperty("error")
    }
  })

  it("cleans a pasted URL and keeps the resolver; ct=0 skips CT", async () => {
    const body = await api(`domain=${encodeURIComponent("https://www.microsoft.com/en-us/")}&ct=0&resolver=google`)
    expect(body).toMatchObject({ domain: "www.microsoft.com", resolver: "google", ct: null })
  })

  it("finds Microsoft 365 records for microsoft.com", { timeout: 30_000 }, async () => {
    const body = await api("domain=microsoft.com&ct=0")
    const has = (group: string, name: string, type?: string) =>
      body[group].some((r: { name: string; type: string }) => r.name === name && (type === undefined || r.type === type))
    expect(has("email", "selector1._domainkey", "CNAME")).toBe(true)
    expect(has("email", "_sipfederationtls._tcp", "SRV")).toBe(true)
    expect(has("subdomains", "lyncdiscover")).toBe(true)
    expect(has("apex", "@", "MX")).toBe(true)
  })

  it("detects the wildcard on github.io", { timeout: 30_000 }, async () => {
    const body = await api("domain=github.io&ct=off")
    expect(body.wildcard.targets.length).toBeGreaterThan(0)
  })

  it("reports DNSSEC validation for cloudflare.com", { timeout: 30_000 }, async () => {
    const body = await api("domain=cloudflare.com&ct=0&dnssec=1")
    expect(body.dnssec).toEqual({ validated: true })
  })

  it("adds CT data, or a note when crt.sh is down", { timeout: 60_000 }, async () => {
    const body = await api("domain=example.com&ct=1")
    expect(body.ct).toHaveProperty("cached")
  })

  it("keeps unexpired, on-domain certificate names only", () => {
    const now = Date.parse("2026-01-01T00:00:00Z")
    const { subdomains, activeCerts } = subdomainsFromCerts("example.com", [
      { name_value: "www.example.com\n*.example.com\nexample.com", not_after: "2027-01-01T00:00:00" },
      { name_value: "old.example.com", not_after: "2025-01-01T00:00:00" },
      { name_value: "api.example.com\nevil.com", not_after: "2026-06-01T00:00:00" },
    ], now)
    expect(subdomains).toEqual(["api", "www"])
    expect(activeCerts).toBe(2)
  })

  it("renders the email checklist and the zone file in the page", { timeout: 30_000 }, async () => {
    const { status, text } = await get("/dns-discovery?domain=example.com&ct=off")
    expect(status).toBe(200)
    expect(text).toContain("DMARC")
    expect(text).toContain("$ORIGIN example.com.")
    expect(text).toContain("; Resolver: Cloudflare 1.1.1.1")
    expect(text).toMatch(/IN\tNS\t/)
  })
})
