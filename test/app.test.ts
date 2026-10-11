import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { startWorker, type TestWorker } from "./helpers.ts"

let worker: TestWorker
// The tool list comes from the Worker itself: the tools import
// cloudflare:sockets, which only exists in workerd.
let tools: ReadonlyArray<{ slug: string; params: Record<string, unknown> }>
beforeAll(async () => {
  worker = await startWorker()
  tools = JSON.parse((await worker.get("/api.json")).text)
})
afterAll(() => worker?.dispose())

describe("app", () => {
  it("lists every tool on the overview", async () => {
    const { status, text } = await worker.get("/")
    expect(status).toBe(200)
    for (const tool of tools) expect(text).toContain(`href="/${tool.slug}"`)
  })

  it("serves the catalog with every tool's parameters", () => {
    expect(tools).toHaveLength(11)
    for (const tool of tools) expect(tool.params, tool.slug).toBeTypeOf("object")
  })

  it("serves the stylesheet", async () => {
    const { status, headers } = await worker.get("/styles.css")
    expect(status).toBe(200)
    expect(headers.get("content-type")).toContain("text/css")
  })

  it("404s unknown paths and redirects a trailing slash", async () => {
    expect((await worker.get("/nope")).status).toBe(404)
    expect((await worker.get("/dns-lookup/api/extra")).status).toBe(404)
    const slashed = await worker.get("/dns-lookup/?name=x.com")
    expect(slashed.status).toBe(301)
    expect(slashed.headers.get("location")).toBe("https://tools.test/dns-lookup?name=x.com")
  })

  it("renders every tool's page", async () => {
    for (const tool of tools) {
      const { status, text } = await worker.get(`/${tool.slug}`)
      expect([200, 400, 502], tool.slug).toContain(status)
      expect(text, tool.slug).toContain(`<form class="tool" method="get" action="/${tool.slug}">`)
    }
  })

  it("escapes query values in the page", async () => {
    const { text } = await worker.get(`/dns-lookup?name=${encodeURIComponent('"><script>x</script>')}`)
    expect(text).not.toContain("<script>x</script>")
  })
})
