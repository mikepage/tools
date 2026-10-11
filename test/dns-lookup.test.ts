import { describe, expect, it } from "vitest"
import { get } from "./helpers.ts"

describe("dns-lookup", () => {
  it("validates DNSSEC for cloudflare.com", async () => {
    const { status, text } = await get("/dns-lookup/api?name=cloudflare.com&type=A")
    expect(status).toBe(200)
    expect(JSON.parse(text)).toMatchObject({ statusText: "No error", dnssec: { enabled: true, validated: true } })
  })

  it("parses MX records and accepts a lowercase type", async () => {
    const body = JSON.parse((await get("/dns-lookup/api?name=google.com&type=mx&resolver=google")).text)
    expect(body.type).toBe("MX")
    expect(body.records[0].value).toHaveProperty("exchange")
  })

  it("cleans a pasted URL and accepts domain as an alias", async () => {
    const body = JSON.parse((await get(`/dns-lookup/api?domain=${encodeURIComponent("https://www.cloudflare.com/x")}`)).text)
    expect(body.name).toBe("www.cloudflare.com")
  })

  it("reports NXDOMAIN as a result, not an error", async () => {
    const body = JSON.parse((await get("/dns-lookup/api?name=does-not-exist.example.invalid")).text)
    expect(body.statusText).toBe("Non-existent domain")
  })

  it("rejects bad input with 400", async () => {
    for (const q of ["", "name=nope", "name=example.com&type=AXFR", "name=example.com&resolver=quad9"]) {
      const { status, text } = await get(`/dns-lookup/api?${q}`)
      expect(status, q).toBe(400)
      expect(JSON.parse(text)).toHaveProperty("error")
    }
  })

  it("renders MX records in the page", async () => {
    const { status, text } = await get("/dns-lookup?name=gmail.com&type=MX")
    expect(status).toBe(200)
    expect(text).toContain("Mail server")
    expect(text).toContain("gmail-smtp-in.l.google.com")
  })
})
