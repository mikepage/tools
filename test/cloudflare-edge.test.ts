import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { distanceKm } from "../src/tools/cloudflare-edge.tsx"
import { startWorker, type TestWorker } from "./helpers.ts"

let worker: TestWorker
beforeAll(async () => {
  worker = await startWorker({ module: "src/tools/cloudflare-edge.tsx", export: "cloudflareEdge" })
})
afterAll(() => worker?.dispose())

const get = (path: string, cf?: Record<string, unknown>) => worker.get(path, cf ? { cf } : {})
const json = async (path: string, cf?: Record<string, unknown>) => JSON.parse((await get(path, cf)).text)

// The harness always fills request.cf with a fallback (DFW, Austin) and merges
// what a test passes over it; null clears a field, as if it were missing.
const NO_CF = Object.fromEntries(
  ["colo", "city", "region", "regionCode", "country", "continent", "isEUCountry", "postalCode", "metroCode", "latitude", "longitude", "timezone", "asn", "asOrganization", "httpProtocol", "tlsVersion", "tlsCipher"]
    .map((k) => [k, null]),
)

const CF = { colo: "AMS", city: "Utrecht", country: "NL", continent: "EU", latitude: "52.09", longitude: "5.12" }

describe("cloudflare-edge", () => {
  it("looks up a colo by code, case-insensitively", async () => {
    expect((await json("/cloudflare-edge/api?colo=NRT")).colo).toMatchObject({ code: "NRT", city: "Tokyo", country: "Japan" })
    expect((await json("/cloudflare-edge/api?colo=ams")).colo).toMatchObject({ code: "AMS", city: "Amsterdam", cca2: "NL" })
  })

  it("rejects unknown and malformed codes with 400 and names the parameter", async () => {
    const unknown = await get("/cloudflare-edge/api?colo=ZZZ")
    expect(unknown.status).toBe(400)
    expect(JSON.parse(unknown.text).error).toBe("colo: unknown colo ZZZ")
    const long = await get("/cloudflare-edge/api?colo=AMST")
    expect(long.status).toBe(400)
    expect(JSON.parse(long.text).error).toMatch(/^colo: expected a three-letter IATA code/)
  })

  it("answers without cf data outside the edge", async () => {
    expect(await json("/cloudflare-edge/api", NO_CF)).toEqual({ servedBy: null, colo: null, serving: false, visitor: null, distanceKm: null })
  })

  it("reports the serving colo and the distance to the visitor", async () => {
    const body = await json("/cloudflare-edge/api", CF)
    expect(body).toMatchObject({ servedBy: "AMS", serving: true, colo: { city: "Amsterdam" }, visitor: { countryName: "Netherlands" } })
    expect(body.distanceKm).toBeGreaterThan(20)
    expect(body.distanceKm).toBeLessThan(60)
  })

  it("measures a looked-up colo from the visitor", async () => {
    const body = await json("/cloudflare-edge/api?colo=NRT", CF)
    expect(body).toMatchObject({ servedBy: "AMS", serving: false, colo: { code: "NRT" } })
    expect(body.distanceKm).toBeGreaterThan(9000)
  })

  it("reports a serving colo missing from the list", async () => {
    const body = await json("/cloudflare-edge/api", { ...NO_CF, colo: "zzz" })
    expect(body).toMatchObject({ servedBy: "ZZZ", colo: null, serving: false, distanceKm: null })
    expect((await get("/cloudflare-edge", { ...NO_CF, colo: "ZZZ" })).text).toContain("not in the bundled list")
  })

  it("uses the fallback cf data the harness adds", async () => {
    expect(await json("/cloudflare-edge/api")).toMatchObject({ servedBy: "DFW", serving: true, colo: { code: "DFW" } })
  })

  it("computes great-circle distances", () => {
    expect(Math.round(distanceKm({ lat: 0, lon: 0 }, { lat: 0, lon: 180 }))).toBe(20015)
  })

  it("renders the page", async () => {
    const served = await get("/cloudflare-edge", CF)
    expect(served.status).toBe(200)
    expect(served.text).toContain("Served from AMS: Amsterdam, Netherlands")
    const looked = await get("/cloudflare-edge?colo=nrt", NO_CF)
    expect(looked.text).toContain("NRT is in Tokyo, Japan")
    expect((await get("/cloudflare-edge", NO_CF)).text).toContain("No Cloudflare data on this request")
  })
})
