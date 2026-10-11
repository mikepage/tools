import { ManagedRuntime } from "effect"
import { FetchHttpClient } from "effect/http"
import { afterAll, describe, expect, it } from "vitest"
import { makeHandler } from "../src/app/handler.ts"
import { cloudflareEdge, distanceKm } from "../src/tools/cloudflare-edge.tsx"

const runtime = ManagedRuntime.make(FetchHttpClient.layer)
const handle = makeHandler([cloudflareEdge])
afterAll(() => runtime.dispose())

const get = async (path: string, cf?: Record<string, unknown>) => {
  const request = Object.assign(new Request(`https://tools.test${path}`), cf ? { cf } : {})
  const response = await runtime.runPromise(handle(request))
  return { status: response.status, text: await response.text() }
}

const json = async (path: string, cf?: Record<string, unknown>) => JSON.parse((await get(path, cf)).text)

const CF = { colo: "AMS", city: "Utrecht", country: "NL", continent: "EU", latitude: "52.09", longitude: "5.12" }

describe("cloudflare-edge", () => {
  it("looks up a colo by code, case-insensitively", async () => {
    expect((await json("/cloudflare-edge/api?colo=NRT")).colo).toMatchObject({ code: "NRT", city: "Tokyo", country: "Japan" })
    expect((await json("/cloudflare-edge/api?colo=ams")).colo).toMatchObject({ code: "AMS", city: "Amsterdam", cca2: "NL" })
  })

  it("rejects unknown and malformed codes with 400", async () => {
    const unknown = await get("/cloudflare-edge/api?colo=ZZZ")
    expect(unknown.status).toBe(400)
    expect(JSON.parse(unknown.text).error).toBe("unknown colo ZZZ")
    const long = await get("/cloudflare-edge/api?colo=AMST")
    expect(long.status).toBe(400)
    expect(JSON.parse(long.text).error).toContain("colo must be a three-letter IATA code")
  })

  it("answers without cf data outside the edge", async () => {
    expect(await json("/cloudflare-edge/api")).toEqual({ servedBy: null, colo: null, serving: false, visitor: null, distanceKm: null })
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

  it("computes great-circle distances", () => {
    expect(Math.round(distanceKm({ lat: 0, lon: 0 }, { lat: 0, lon: 180 }))).toBe(20015)
  })

  it("renders the page", async () => {
    const served = await get("/cloudflare-edge", CF)
    expect(served.status).toBe(200)
    expect(served.text).toContain("Served from AMS: Amsterdam, Netherlands")
    const looked = await get("/cloudflare-edge?colo=nrt")
    expect(looked.text).toContain("NRT is in Tokyo, Japan")
    expect((await get("/cloudflare-edge")).text).toContain("No Cloudflare data on this request")
  })
})
