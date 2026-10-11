import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { startWorker, type TestWorker } from "./helpers.ts"

let worker: TestWorker
beforeAll(async () => {
  worker = await startWorker({ module: "src/tools/spf-validator.tsx", export: "spfValidator" })
})
afterAll(() => worker?.dispose())

const get = (path: string) => worker.get(path)
/** Evaluates a draft record for example.com. */
const draft = async (record: string) =>
  JSON.parse((await get(`/spf-validator/api?domain=example.com&record=${encodeURIComponent(record)}`)).text)
const texts = (body: { issues: Array<{ text: string }> }) => body.issues.map((i) => i.text).join("\n")

describe("spf-validator", () => {
  it("walks google.com's includes", async () => {
    const { status, text } = await get("/spf-validator/api?domain=google.com&resolver=cloudflare")
    expect(status).toBe(200)
    const body = JSON.parse(text)
    expect(body.resolver).toBe("cloudflare")
    expect(body.node.record).toMatch(/^v=spf1/)
    expect(text).toContain("_spf.google.com")
    expect(text).toContain(`"via":"include"`)
    expect(body.lookups).toBeGreaterThan(0)
    expect(body.maxLookups).toBe(10)
  })

  it("passes a clean record without lookups", async () => {
    expect(await draft("v=spf1 ip4:192.0.2.1 -all")).toMatchObject({ lookups: 0, issues: [], draft: true })
  })

  it("flags common mistakes", async () => {
    const cases: Array<[string, string]> = [
      ["v=spf1 +all", "\"+all\" allows the whole internet"],
      ["v=spf1 ?all", "SPF effectively does nothing"],
      ["v=spf1 -all mx", "should be the last mechanism"],
      ["v=spf1 mx", "Consider adding -all or ~all"],
      ["v=spf1 redirect=a.example redirect=b.example", "Multiple \"redirect\" modifiers"],
      ["v=spf1 include: -all", "Missing domain for include/redirect"],
      ["v=spf1 ptr -all", "deprecated"],
      ["v=spf2 -all", "Invalid version"],
      ["v=spf1 include:%{i}.example -all", "Contains SPF macros"],
      ["v=spf1 include:nope.invalid -all", "DNS lookup failed: Non-existent domain"],
    ]
    for (const [record, expected] of cases) expect(texts(await draft(record)), record).toContain(expected)
  })

  it("does not count exp= as a mechanism after all", async () => {
    expect(texts(await draft("v=spf1 -all exp=explain.example"))).not.toContain("should be the last")
  })

  it("ignores redirect when all is present, follows it otherwise", async () => {
    const ignored = await draft("v=spf1 -all redirect=_spf.google.com")
    expect(ignored.lookups).toBe(0)
    expect(texts(ignored)).toContain("\"redirect\" is ignored")
    const followed = await draft("v=spf1 redirect=_spf.google.com")
    expect(followed.lookups).toBe(1)
    expect(followed.node.terms[0]).toMatchObject({ lookup: 1, child: { via: "redirect", domain: "_spf.google.com" } })
  })

  it("stops following includes past 10 lookups", async () => {
    const includes = Array.from({ length: 12 }, (_, i) => `include:a${i + 1}.invalid`).join(" ")
    const body = await draft(`v=spf1 ${includes} -all`)
    expect(body.lookups).toBe(12)
    expect(body.node.terms[10].child.note).toContain("DNS lookup limit exceeded (10)")
    expect(texts(body)).toContain("Too many DNS lookups: 12")
  })

  it("rejects bad input with 400 and names the parameter", async () => {
    const cases: Array<[string, string]> = [
      ["", "domain"],
      ["domain=localhost", "domain"],
      ["domain=google.com&resolver=nope", "resolver"],
      [`domain=example.com&record=${"a".repeat(4097)}`, "record"],
    ]
    for (const [q, param] of cases) {
      const { status, text } = await get(`/spf-validator/api?${q}`)
      expect(status, q.slice(0, 40)).toBe(400)
      expect(JSON.parse(text).error, q.slice(0, 40)).toMatch(new RegExp(`^${param}:`))
    }
  })

  it("renders the lookup budget and the include tree", async () => {
    const { status, text } = await get(`/spf-validator?domain=example.com&record=${encodeURIComponent("v=spf1 redirect=_spf.google.com")}`)
    expect(status).toBe(200)
    expect(text).toContain("1 of 10 allowed DNS lookups used")
    expect(text).toContain("Include tree")
    expect(text).toContain("lookup 1/10")
  })
})
