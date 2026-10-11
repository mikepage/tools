import { ManagedRuntime } from "effect"
import { FetchHttpClient } from "effect/http"
import { afterAll, describe, expect, it } from "vitest"
import { makeHandler } from "../src/app/handler.ts"
import { intlTelValidate } from "../src/tools/intl-tel-validate.tsx"

const runtime = ManagedRuntime.make(FetchHttpClient.layer)
const handle = makeHandler([intlTelValidate])
afterAll(() => runtime.dispose())

// `cf` is what Cloudflare attaches to a request; Node's Request has none.
const get = async (path: string, cf?: Record<string, unknown>) => {
  const request = new Request(`https://tools.test${path}`)
  if (cf) Object.defineProperty(request, "cf", { value: cf })
  const response = await runtime.runPromise(handle(request))
  return { status: response.status, text: await response.text() }
}
const api = async (query: string, cf?: Record<string, unknown>) => {
  const { status, text } = await get(`/intl-tel-validate/api?${query}`, cf)
  return { status, body: JSON.parse(text) }
}

describe("intl-tel-validate", () => {
  it("validates and formats a Dutch mobile number", async () => {
    const { status, body } = await api("number=%2B31612345678")
    expect(status).toBe(200)
    expect(body).toMatchObject({
      valid: true,
      country: "NL",
      countryName: "Netherlands",
      numberType: "Mobile",
      e164: "+31612345678",
      international: "+31 6 12345678",
    })
  })

  it("enforces the required type", async () => {
    const fixed = (await api("number=0201234567&country=nl&type=mobile")).body
    expect(fixed).toMatchObject({ valid: false, error: "Expected mobile number, got Fixed line", national: "020 123 4567" })
    const mobile = (await api("number=%2B31612345678&type=fixed_line")).body
    expect(mobile).toMatchObject({ valid: false, error: "Expected fixed line number, got Mobile" })
  })

  it("explains why a number is invalid", async () => {
    expect((await api("number=%2B316abc&strict=1")).body).toMatchObject({ valid: false, error: "Not a number" })
    expect((await api("number=%2B3161")).body).toMatchObject({ valid: false, error: "Number too short" })
  })

  it("takes the visitor's country for a number without +", async () => {
    const { body } = await api("number=0612345678", { country: "NL" })
    expect(body).toMatchObject({ valid: true, country: "NL", assumedCountry: "NL", e164: "+31612345678" })
    // An explicit country, or a + prefix, wins.
    expect((await api("number=0612345678&country=NL", { country: "US" })).body).not.toHaveProperty("assumedCountry")
    expect((await api("number=%2B31612345678", { country: "US" })).body).not.toHaveProperty("assumedCountry")
  })

  it("rejects bad input with 400", async () => {
    for (const [q, message] of [
      ["", "Please enter a phone number"],
      ["number=0612345678&country=ZZ", "Unknown country ZZ"],
      ["number=0612345678&type=pager", ""],
    ] as const) {
      const { status, body } = await api(q)
      expect(status, q).toBe(400)
      expect(body.error, q).toContain(message)
    }
  })

  it("renders the verdict in the page", async () => {
    const { status, text } = await get("/intl-tel-validate?number=%2B31612345678")
    expect(status).toBe(200)
    expect(text).toContain("Valid mobile number from Netherlands")
    expect(text).toContain("tel:+31612345678")
  })
})
