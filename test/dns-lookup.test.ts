import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { startWorker, type TestWorker } from "./helpers.ts"

let worker: TestWorker
beforeAll(async () => {
  worker = await startWorker({ module: "src/tools/dns-lookup.tsx", export: "dnsLookup" })
})
afterAll(() => worker?.dispose())

describe("dns-lookup", () => {
  it("validates DNSSEC for cloudflare.com", async () => {
    const { status, text } = await worker.get("/dns-lookup/api?name=cloudflare.com&type=A")
    expect(status).toBe(200)
    expect(JSON.parse(text)).toMatchObject({ statusText: "No error", dnssec: { enabled: true, validated: true } })
  })

  it("parses MX records and accepts a lowercase type", async () => {
    const body = JSON.parse((await worker.get("/dns-lookup/api?name=google.com&type=mx&resolver=google")).text)
    expect(body.type).toBe("MX")
    expect(body.records[0].value).toHaveProperty("exchange")
  })

  it("cleans a pasted URL and accepts domain as an alias", async () => {
    const body = JSON.parse((await worker.get(`/dns-lookup/api?domain=${encodeURIComponent("https://www.cloudflare.com/x")}`)).text)
    expect(body.name).toBe("www.cloudflare.com")
  })

  it("reports NXDOMAIN as a result, not an error", async () => {
    const body = JSON.parse((await worker.get("/dns-lookup/api?name=does-not-exist.example.invalid")).text)
    expect(body.statusText).toBe("Non-existent domain")
  })

  it("rejects bad input with 400 and names the parameter", async () => {
    for (const [q, param] of [["", "name"], ["name=nope", "name"], ["name=example.com&type=AXFR", "type"], ["name=example.com&resolver=quad9", "resolver"], ["name=example.com&dnssec=maybe", "dnssec"]]) {
      const { status, text } = await worker.get(`/dns-lookup/api?${q}`)
      expect(status, q).toBe(400)
      expect(JSON.parse(text).error, q).toMatch(new RegExp(`^${param}:`))
    }
  })

  it("renders MX records in the page", async () => {
    const { status, text } = await worker.get("/dns-lookup?name=gmail.com&type=MX")
    expect(status).toBe(200)
    expect(text).toContain("Mail server")
    expect(text).toContain("gmail-smtp-in.l.google.com")
  })
})
