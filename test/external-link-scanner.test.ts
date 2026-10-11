import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createTestHarness } from "wrangler"
import { groupByDomain, type PageRefs, registrableDomain } from "../src/tools/external-link-scanner.tsx"
import { startWorker, type TestWorker } from "./helpers.ts"

// extractRefs needs HTMLRewriter, so it runs in workerd too: a second worker
// that answers a POSTed page with its refs as JSON.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const OUT = join(ROOT, ".test-build")
const startExtractor = async () => {
  mkdirSync(OUT, { recursive: true })
  const entry = join(OUT, "extractRefs.entry.ts")
  writeFileSync(
    entry,
    [
      `import { extractRefs } from ${JSON.stringify(join(ROOT, "src/tools/external-link-scanner.tsx"))}`,
      `export default { fetch: async (request: Request) => Response.json(await extractRefs(await request.text(), request.headers.get("x-base") ?? "")) }`,
    ].join("\n"),
  )
  const configPath = join(OUT, "extractRefs.wrangler.jsonc")
  writeFileSync(configPath, JSON.stringify({ name: "test-extract-refs", main: entry, compatibility_date: "2026-09-30" }))
  const harness = createTestHarness({ root: ROOT, workers: [{ configPath }] })
  await harness.listen()
  return {
    extract: async (html: string, base: string): Promise<PageRefs> => {
      const response = await harness.fetch("https://extract.test/", { method: "POST", body: html, headers: { "x-base": base } })
      return (await response.json()) as PageRefs
    },
    dispose: () => harness.close(),
  }
}

let worker: TestWorker
let extractor: Awaited<ReturnType<typeof startExtractor>>
beforeAll(async () => {
  ;[worker, extractor] = await Promise.all([
    startWorker({ module: "src/tools/external-link-scanner.tsx", export: "externalLinkScanner" }),
    startExtractor(),
  ])
})
afterAll(async () => {
  await worker?.dispose()
  await extractor?.dispose()
})

const api = async (query: string) => {
  const { status, text } = await worker.get(`/external-link-scanner/api?${query}`)
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
    expect(icann.refs.some((r: { text: string }) => r.text.length > 0)).toBe(true)
  }, 30_000)

  it("reports no domains for a page without external links", async () => {
    const { status, body } = await api("url=https://example.com&maxPages=1")
    expect(status).toBe(200)
    expect(body).toMatchObject({ site: "https://example.com", pagesScanned: 1 })
    expect(body.domains.every((d: { domain: string }) => d.domain !== "example.com")).toBe(true)
  }, 30_000)

  it("crawls internal links up to maxPages", async () => {
    const { status, body } = await api(`url=${encodeURIComponent("https://www.iana.org/")}&maxPages=3`)
    expect(status).toBe(200)
    expect(body.pagesScanned).toBe(3)
  }, 60_000)

  it("rejects bad input with 400 and names the parameter", async () => {
    for (const [q, param] of [
      ["url=ftp%3A%2F%2Fexample.com", "url"],
      ["", "url"],
      ["url=example.com&maxPages=0", "maxPages"],
      ["url=example.com&maxPages=two", "maxPages"],
    ] as const) {
      const { status, body } = await api(q)
      expect(status, q).toBe(400)
      expect(body.error, q).toMatch(new RegExp(`^${param}:`))
    }
  })

  it("answers 502 when the start page fails", async () => {
    const { status, body } = await api(`url=${encodeURIComponent("https://example.com/this-page-does-not-exist")}`)
    expect(status).toBe(502)
    expect(body.error).toContain("HTTP 404")
  }, 30_000)

  it("extracts links, scripts, iframes and forms with HTMLRewriter", async () => {
    const html = `
      <!-- <a href="https://hidden.example">no</a> -->
      <a href="/about">About</a>
      <a href="https://cheap-pills.top/buy?a=1&amp;b=2" rel="nofollow">Best <b>casino</b> &amp;   more</a>
      <a href="mailto:x@example.com">mail</a>
      <a name="anchor-without-href">x</a>
      <script src="//cdn.example.net/x.js"></script>
      <script>document.write('<a href="https://inline.example">')</script>
      <iframe src="https://203.0.113.9/frame"></iframe>
      <form action="https://forms.example.co.uk/post"></form>`
    const refs = await extractor.extract(html, "https://site.test/page")
    expect(refs.anchors).toEqual([
      { url: "https://site.test/about", text: "About", rel: "" },
      { url: "https://cheap-pills.top/buy?a=1&b=2", text: "Best casino & more", rel: "nofollow" },
    ])
    expect(refs.scripts).toEqual(["https://cdn.example.net/x.js"])
    expect(refs.iframes).toEqual(["https://203.0.113.9/frame"])
    expect(refs.forms).toEqual(["https://forms.example.co.uk/post"])
  })

  it("groups by registrable domain and flags spam", () => {
    expect(registrableDomain("shop.example.co.uk")).toBe("example.co.uk")
    const groups = groupByDomain([
      { url: "https://cheap-pills.top/buy", host: "cheap-pills.top", kind: "link", page: "https://site.test/page", text: "Best casino", rel: "nofollow", nofollow: true },
      { url: "https://cdn.example.net/x.js", host: "cdn.example.net", kind: "script", page: "https://site.test/page", text: "", rel: "", nofollow: false },
    ])
    expect(groups[0]).toMatchObject({ domain: "cheap-pills.top", suspicious: true })
    expect(groups[0]!.reasons.join(" ")).toMatch(/nonstandard TLD \.top.*casino/)
    expect(groups[1]).toMatchObject({ domain: "example.net", suspicious: false })
  })

  it("renders the domains in the page", async () => {
    const { status, text } = await worker.get(`/external-link-scanner?url=${IANA}&maxPages=1`)
    expect(status).toBe(200)
    expect(text).toContain("External domains")
    expect(text).toContain(`href="#d-icann.org"`)
    expect(text).toContain(`id="d-icann.org"`)
  }, 30_000)
})
