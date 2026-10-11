import { ManagedRuntime } from "effect"
import { FetchHttpClient } from "effect/http"
import { afterAll, describe, expect, it } from "vitest"
import { makeHandler } from "../src/app/handler.ts"
import { ipInfo } from "../src/tools/ip-info.tsx"

const runtime = ManagedRuntime.make(FetchHttpClient.layer)
const handle = makeHandler([ipInfo])
afterAll(() => runtime.dispose())

const get = async (path: string, headers: Record<string, string> = {}, cf?: Record<string, unknown>) => {
  const request = Object.assign(new Request(`https://tools.test${path}`, { headers }), cf ? { cf } : {})
  const response = await runtime.runPromise(handle(request))
  return { status: response.status, headers: response.headers, text: await response.text() }
}

const CF = {
  city: "Amsterdam",
  region: "North Holland",
  regionCode: "NH",
  country: "NL",
  continent: "EU",
  isEUCountry: "1",
  postalCode: "1012",
  latitude: "52.37",
  longitude: "4.89",
  timezone: "Europe/Amsterdam",
  asn: 1136,
  asOrganization: "KPN",
  colo: "AMS",
}

describe("ip-info", () => {
  it("returns the visitor's IP with CORS and no caching", async () => {
    const { status, headers, text } = await get("/ip-info/api", { "cf-connecting-ip": "192.0.2.7" })
    expect(status).toBe(200)
    expect(headers.get("access-control-allow-origin")).toBe("*")
    expect(headers.get("cache-control")).toBe("no-store")
    expect(JSON.parse(text)).toMatchObject({ ip: "192.0.2.7", version: 4, isEU: false })
  })

  it("detects IPv6", async () => {
    const body = JSON.parse((await get("/ip-info/api", { "cf-connecting-ip": "2a01:4f8::7" })).text)
    expect(body).toMatchObject({ ip: "2a01:4f8::7", version: 6 })
  })

  it("reads location and network from request.cf", async () => {
    const body = JSON.parse((await get("/ip-info/api", { "cf-connecting-ip": "192.0.2.7" }, CF)).text)
    expect(body).toMatchObject({
      city: "Amsterdam",
      country: "NL",
      isEU: true,
      postal: "1012",
      loc: "52.37,4.89",
      asn: 1136,
      org: "AS1136 KPN",
      colo: "AMS",
    })
  })

  it("picks a subset with fields", async () => {
    const body = JSON.parse((await get("/ip-info/api?fields=ip,version", { "cf-connecting-ip": "192.0.2.7" })).text)
    expect(body).toEqual({ ip: "192.0.2.7", version: 4 })
  })

  it("rejects unknown fields with 400", async () => {
    const { status, text } = await get("/ip-info/api?fields=ip,password")
    expect(status).toBe(400)
    expect(JSON.parse(text).error).toContain("fields must be a comma-separated list of")
  })

  it("renders without a query, with or without cf", async () => {
    const bare = await get("/ip-info", { "cf-connecting-ip": "192.0.2.7" })
    expect(bare.status).toBe(200)
    expect(bare.text).toContain("192.0.2.7")
    expect(bare.text).toContain("No location data")
    const full = await get("/ip-info", { "cf-connecting-ip": "192.0.2.7" }, CF)
    expect(full.text).toContain("Amsterdam, North Holland, Netherlands")
    expect(full.text).toContain("AS1136 KPN")
  })
})
