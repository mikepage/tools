import { ManagedRuntime } from "effect"
import { FetchHttpClient } from "effect/http"
import { afterAll, describe, expect, it } from "vitest"
import { makeHandler } from "../src/app/handler.ts"
import { externalLinkScanner, extractRefs, groupByDomain, registrableDomain } from "../src/tools/external-link-scanner.tsx"

const runtime = ManagedRuntime.make(FetchHttpClient.layer)
const handle = makeHandler([externalLinkScanner])
afterAll(() => runtime.dispose())

const get = async (path: string) => {
  const response = await runtime.runPromise(handle(new Request(`https://tools.test${path}`)))
  return { status: response.status, text: await response.text() }
}
const api = async (query: string) => {
  const { status, text } = await get(`/external-link-scanner/api?${query}`)
  return { status, body: JSON.parse(text) }
}

const IANA = encodeURIComponent("https://www.iana.org/help/example-domains")

describe("external-link-scanner", () => {
  it("groups the external links of one page by domain", async () => {
    const { status, body } = await api(`url=${IANA}&maxPages=1`)
    expect(status).toBe(200)
    expect(body).toMatchObject({ site: "https://www.iana.org", pagesScanned: 1 })
    const icann = body.domains.find((d: { domain: string }) => d.domain === "icann.org")
    expect(icann).toMatchObject({ suspicious: false, hosts: ["pti.icann.org", "www.icann.org"] })
    expect(icann.refs[0].kind).toBe("link")
  }, 30_000)

  it("reports no domains for a page without external links", async () => {
    const { status, body } = await api("url=https://example.com&maxPages=1")
    expect(status).toBe(200)
    expect(body).toMatchObject({ site: "https://example.com", pagesScanned: 1 })
    expect(body.domains.every((d: { domain: string }) => d.domain !== "example.com")).toBe(true)
  }, 30_000)

  it("rejects bad input with 400", async () => {
    for (const [q, message] of [
      ["url=ftp%3A%2F%2Fexample.com", "valid http(s) URL"],
      ["", "valid http(s) URL"],
      ["url=example.com&maxPages=0", ""],
    ] as const) {
      const { status, body } = await api(q)
      expect(status, q).toBe(400)
      expect(body.error, q).toContain(message)
    }
  })

  it("answers 502 when the start page fails", async () => {
    const { status, body } = await api(`url=${encodeURIComponent("https://example.com/this-page-does-not-exist")}`)
    expect(status).toBe(502)
    expect(body.error).toContain("HTTP 404")
  }, 30_000)

  it("extracts links, scripts, iframes and forms, and flags spam", () => {
    const html = `
      <!-- <a href="https://hidden.example">no</a> -->
      <a href="/about">About</a>
      <a href="https://cheap-pills.top/buy?a=1&amp;b=2" rel="nofollow">Best casino</a>
      <script src="//cdn.example.net/x.js"></script>
      <iframe src="https://203.0.113.9/frame"></iframe>
      <form action="https://forms.example.co.uk/post"></form>`
    const refs = extractRefs(html, "https://site.test/page")
    expect(refs.anchors.map((a) => a.url)).toEqual(["https://site.test/about", "https://cheap-pills.top/buy?a=1&b=2"])
    expect(refs.scripts).toEqual(["https://cdn.example.net/x.js"])
    expect(registrableDomain("shop.example.co.uk")).toBe("example.co.uk")

    const groups = groupByDomain([
      { url: refs.anchors[1]!.url, host: "cheap-pills.top", kind: "link", page: "https://site.test/page", text: "Best casino", rel: "nofollow", nofollow: true },
      { url: refs.scripts[0]!, host: "cdn.example.net", kind: "script", page: "https://site.test/page", text: "", rel: "", nofollow: false },
    ])
    expect(groups[0]).toMatchObject({ domain: "cheap-pills.top", suspicious: true })
    expect(groups[0]!.reasons.join(" ")).toMatch(/nonstandard TLD \.top.*casino/)
    expect(groups[1]).toMatchObject({ domain: "example.net", suspicious: false })
  })

  it("renders the domains in the page", async () => {
    const { status, text } = await get(`/external-link-scanner?url=${IANA}&maxPages=1`)
    expect(status).toBe(200)
    expect(text).toContain("External domains")
    expect(text).toContain(`href="#d-icann.org"`)
    expect(text).toContain(`id="d-icann.org"`)
  }, 30_000)
})
