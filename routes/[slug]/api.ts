// GET /<slug>/api: the tool's run as JSON.

import { defineHandler } from "void"
import { notFoundPage, toolApi } from "../../src/app/handler.ts"
import { toolBySlug } from "../../src/tools/index.ts"

export const GET = defineHandler((c) => {
  const tool = toolBySlug(c.req.param("slug"))
  return tool ? toolApi(tool, c.req.raw) : notFoundPage()
})
