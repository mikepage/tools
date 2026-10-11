// The live SMTP probe needs cloudflare:sockets, so these tests cover the
// input validation and the SSRF guard, which run before any socket opens.

import { ManagedRuntime } from "effect"
import { FetchHttpClient } from "effect/http"
import { afterAll, describe, expect, it } from "vitest"
import { makeHandler } from "../src/app/handler.ts"
import { capabilitiesOf, isPrivateAddress, smtpSubmissionTest } from "../src/tools/smtp-submission-test.tsx"

const runtime = ManagedRuntime.make(FetchHttpClient.layer)
const handle = makeHandler([smtpSubmissionTest])
afterAll(() => runtime.dispose())

const get = async (path: string) => {
  const response = await runtime.runPromise(handle(new Request(`https://tools.test${path}`)))
  return { status: response.status, text: await response.text() }
}

describe("smtp-submission-test", () => {
  it("rejects bad input with 400", async () => {
    const cases: Array<[string, string]> = [
      ["", "invalid hostname"],
      ["host=notahost", "invalid hostname"],
      ["host=smtp.gmail.com&port=25", "port must be 587, 465, or 2525"],
      ["host=10.0.0.1", "IP addresses are not accepted"],
      ["host=%5B::1%5D", "IP addresses are not accepted"],
    ]
    for (const [q, message] of cases) {
      const { status, text } = await get(`/smtp-submission-test/api?${q}`)
      expect(status, q).toBe(400)
      expect(JSON.parse(text).error, q).toContain(message)
    }
  })

  it("refuses hosts that resolve to private addresses or nothing", async () => {
    const local = await get("/smtp-submission-test/api?host=localtest.me")
    expect(local.status).toBe(400)
    expect(JSON.parse(local.text).error).toContain("private or reserved address")
    const missing = await get("/smtp-submission-test/api?host=no-such-host.invalid")
    expect(missing.status).toBe(400)
    expect(JSON.parse(missing.text).error).toContain("does not resolve")
  })

  it("classifies addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "100.64.0.1", "169.254.1.1", "0.0.0.0", "224.0.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true)
    }
    for (const ip of ["::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "2001:db8::1"]) expect(isPrivateAddress(ip), ip).toBe(true)
    for (const ip of ["142.250.102.108", "1.1.1.1", "2a00:1450:4013:c00::6c"]) expect(isPrivateAddress(ip), ip).toBe(false)
  })

  it("parses EHLO capabilities", () => {
    expect(capabilitiesOf(["250-smtp.example.com at your service", "250-SIZE 35882577", "250-STARTTLS", "250 SMTPUTF8"]))
      .toEqual(["SIZE 35882577", "STARTTLS", "SMTPUTF8"])
  })

  it("renders the empty form with the port choice", async () => {
    const { status, text } = await get("/smtp-submission-test")
    expect(status).toBe(200)
    expect(text).toContain("465 (implicit TLS)")
  })
})
