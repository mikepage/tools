import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { startWorker, type TestWorker } from "./helpers.ts"

let worker: TestWorker
beforeAll(async () => {
  worker = await startWorker({ module: "src/tools/ip-info.tsx", export: "ipInfo" })
})
afterAll(() => worker?.dispose())

const get = (path: string, headers: Record<string, string> = {}, cf?: Record<string, unknown>) =>
  worker.get(path, { headers, ...(cf ? { cf } : {}) })
const json = async (path: string, headers: Record<string, string> = {}, cf?: Record<string, unknown>) =>
  JSON.parse((await get(path, headers, cf)).text)

// The harness always fills request.cf with a fallback (DFW, Austin) and merges
// what a test passes over it; null clears a field, as if it were missing.
const NO_CF = Object.fromEntries(
  ["colo", "city", "region", "regionCode", "country", "continent", "isEUCountry", "postalCode", "metroCode", "latitude", "longitude", "timezone", "asn", "asOrganization", "httpProtocol", "tlsVersion", "tlsCipher"]
    .map((k) => [k, null]),
)

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
    const { status, headers, text } = await get("/ip-info/api", { "cf-connecting-ip": "192.0.2.7" }, NO_CF)
    expect(status).toBe(200)
    expect(headers.get("access-control-allow-origin")).toBe("*")
    expect(headers.get("cache-control")).toBe("no-store")
    expect(JSON.parse(text)).toEqual({ ip: "192.0.2.7", version: 4, isEU: false })
  })

  it("detects IPv6", async () => {
    expect(await json("/ip-info/api", { "cf-connecting-ip": "2a01:4f8::7" })).toMatchObject({ ip: "2a01:4f8::7", version: 6 })
  })

  it("reads location and network from request.cf", async () => {
    expect(await json("/ip-info/api", { "cf-connecting-ip": "192.0.2.7" }, CF)).toMatchObject({
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

  it("leaves out what request.cf does not say", async () => {
    const body = await json("/ip-info/api", { "cf-connecting-ip": "192.0.2.7" }, { ...NO_CF, country: "DE", isEUCountry: "1", longitude: "4.89" })
    expect(body).toEqual({ ip: "192.0.2.7", version: 4, country: "DE", isEU: true })
  })

  it("picks a subset with fields", async () => {
    expect(await json("/ip-info/api?fields=ip,version", { "cf-connecting-ip": "192.0.2.7" })).toEqual({ ip: "192.0.2.7", version: 4 })
  })

  it("rejects unknown fields with 400 and names the parameter", async () => {
    const { status, text } = await get("/ip-info/api?fields=ip,password")
    expect(status).toBe(400)
    expect(JSON.parse(text).error).toMatch(/^fields: expected a comma-separated list of/)
  })

  it("renders without a query, with or without cf", async () => {
    const bare = await get("/ip-info", { "cf-connecting-ip": "192.0.2.7" }, NO_CF)
    expect(bare.status).toBe(200)
    expect(bare.text).toContain("192.0.2.7")
    expect(bare.text).toContain("No location data")
    const full = await get("/ip-info", { "cf-connecting-ip": "192.0.2.7" }, CF)
    expect(full.text).toContain("Amsterdam, North Holland, Netherlands")
    expect(full.text).toContain("AS1136 KPN")
  })
})
