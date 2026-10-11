import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { startWorker, type TestWorker } from "./helpers.ts"

let worker: TestWorker
beforeAll(async () => {
  worker = await startWorker({ module: "src/tools/dmarc-validator.tsx", export: "dmarcValidator" })
})
afterAll(() => worker?.dispose())

const api = async (query: string) => JSON.parse((await worker.get(`/dmarc-validator/api?${query}`)).text)

describe("dmarc-validator", () => {
  it("reads google.com's reject policy", async () => {
    const body = await api("domain=google.com")
    expect(body).toMatchObject({ domain: "google.com", resolver: "cloudflare", policy: "reject", dnsError: null })
    expect(body.queryTime).toBeTypeOf("number")
    expect(body.records[0].checks).toContainEqual({ level: "ok", text: "v=DMARC1 present and first." })
    expect(body.records[0].tags).toContainEqual(expect.objectContaining({ tag: "p", description: "Failing mail is rejected outright" }))
  })

  it("cleans a pasted _dmarc URL and uses the chosen resolver", async () => {
    const body = await api(`domain=${encodeURIComponent("https://_dmarc.Google.com/path")}&resolver=google`)
    expect(body).toMatchObject({ domain: "google.com", resolver: "google" })
    expect(body.policyDescription).toContain("strict DMARC policy")
    expect(body.records[0].tags[0].description).toBe("DMARC version: DMARC1")
  })

  it("reports a missing record as a result", async () => {
    const body = await api("domain=no-such-domain-7f3a9c2e.example")
    expect(body).toMatchObject({ records: [], policy: null, status: 3, dnsError: null })
  })

  it("reports a resolver failure as dnsError", async () => {
    expect(await api("domain=dnssec-failed.org")).toMatchObject({ status: 2, dnsError: "Server failure" })
  })

  it("rejects bad input with 400 and names the parameter", async () => {
    for (const [q, param] of [["", "domain"], ["domain=not%20a%20domain", "domain"], ["domain=_dmarc.com", "domain"], ["domain=google.com&resolver=nope", "resolver"]]) {
      const { status, text } = await worker.get(`/dmarc-validator/api?${q}`)
      expect(status, q).toBe(400)
      expect(JSON.parse(text).error, q).toMatch(new RegExp(`^${param}:`))
    }
  })

  it("renders the policy, checks and tags", async () => {
    const { status, text } = await worker.get("/dmarc-validator?domain=google.com")
    expect(status).toBe(200)
    expect(text).toContain("strict DMARC policy")
    expect(text).toContain("Meaning")
    expect(text).toContain("v=DMARC1")
  })
})
