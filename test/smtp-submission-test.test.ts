import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { capabilitiesOf, isPrivateAddress } from "../src/lib/smtp-submission-test.ts"
import { startWorker, type TestWorker } from "./helpers.ts"

let worker: TestWorker
beforeAll(async () => {
  worker = await startWorker({ module: "src/tools/smtp-submission-test.tsx", export: "smtpSubmissionTest" })
})
afterAll(() => worker?.dispose())

const get = (path: string) => worker.get(path)
const api = async (query: string) => JSON.parse((await get(`/smtp-submission-test/api?${query}`)).text)

describe("smtp-submission-test", () => {
  it("upgrades smtp.gmail.com:587 with STARTTLS", async () => {
    const body = await api("host=smtp.gmail.com&port=587")
    expect(body, body.error).toMatchObject({ success: true, protocol: "starttls", tlsUpgraded: true, host: "smtp.gmail.com", port: 587 })
    expect(body.greeting).toMatch(/^220 /)
    expect(body.plaintextCapabilities).toContain("STARTTLS")
    expect(body.capabilities.some((c: string) => c.startsWith("AUTH"))).toBe(true)
    expect(body.logs.map((l: { message: string }) => l.message)).toContain("TLS handshake done")
  }, 30_000)

  it("speaks implicit TLS to smtp.gmail.com:465", async () => {
    const body = await api("host=smtp.gmail.com&port=465")
    expect(body, body.error).toMatchObject({ success: true, protocol: "implicit-tls", tlsUpgraded: true })
    expect(body.greeting).toMatch(/^220 /)
    expect(body.plaintextCapabilities).toBeUndefined()
    expect(body.capabilities.some((c: string) => c.startsWith("AUTH"))).toBe(true)
  }, 30_000)

  it("rejects bad input with 400 and names the parameter", async () => {
    const cases: Array<[string, string, string]> = [
      ["", "host", "required"],
      ["host=notahost", "host", "expected a hostname"],
      ["host=smtp.gmail.com&port=25", "port", "587, 465 or 2525"],
      ["host=10.0.0.1", "host", "IP addresses are not accepted"],
      ["host=%5B::1%5D", "host", "IP addresses are not accepted"],
    ]
    for (const [q, param, message] of cases) {
      const { status, text } = await get(`/smtp-submission-test/api?${q}`)
      expect(status, q).toBe(400)
      const { error } = JSON.parse(text)
      expect(error, q).toMatch(new RegExp(`^${param}:`))
      expect(error, q).toContain(message)
    }
  })

  it("refuses hosts that resolve to private addresses or nothing", async () => {
    const local = await get("/smtp-submission-test/api?host=localtest.me")
    expect(local.status).toBe(400)
    expect(JSON.parse(local.text).error).toMatch(/^host: .*private or reserved address/)
    const missing = await get("/smtp-submission-test/api?host=no-such-host.invalid")
    expect(missing.status).toBe(400)
    expect(JSON.parse(missing.text).error).toMatch(/^host: .*does not resolve/)
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

  it("renders the transcript of a live probe", async () => {
    const { status, text } = await get("/smtp-submission-test?host=smtp.gmail.com&port=587")
    expect(status).toBe(200)
    expect(text).toContain("STARTTLS offered and the TLS upgrade worked.")
    expect(text).toContain("Transcript")
  }, 30_000)
})
