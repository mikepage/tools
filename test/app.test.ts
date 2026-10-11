import { describe, expect, it } from "vitest"
import { tools } from "../src/tools/index.ts"
import { get } from "./helpers.ts"

describe("app", () => {
  it("lists every tool on the overview", async () => {
    const { status, text } = await get("/")
    expect(status).toBe(200)
    for (const tool of tools) expect(text).toContain(`href="/${tool.slug}"`)
  })

  it("serves the stylesheet", async () => {
    const { status, headers } = await get("/styles.css")
    expect(status).toBe(200)
    expect(headers.get("content-type")).toContain("text/css")
  })

  it("404s unknown paths", async () => {
    expect((await get("/nope")).status).toBe(404)
    expect((await get("/dns-lookup/api/extra")).status).toBe(404)
  })

  it("renders every tool's empty form", async () => {
    for (const tool of tools.filter((t) => !t.autorun)) {
      const { status, text } = await get(`/${tool.slug}`)
      expect(status, tool.slug).toBe(200)
      expect(text, tool.slug).toContain(`<form class="tool" method="get" action="/${tool.slug}">`)
    }
  })

  it("escapes query values in the page", async () => {
    const { text } = await get(`/dns-lookup?name=${encodeURIComponent('"><script>x</script>')}`)
    expect(text).not.toContain("<script>x</script>")
  })
})
