// GET /<slug>: the tool's page.

import { defineHandler } from "void"
import { notFoundPage, toolPage } from "../../src/app/handler.ts"
import { toolBySlug } from "../../src/tools/index.ts"

export const GET = defineHandler((c) => {
  const tool = toolBySlug(c.req.param("slug"))
  return tool ? toolPage(tool, c.req.raw) : notFoundPage()
})
