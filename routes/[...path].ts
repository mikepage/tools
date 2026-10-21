// Every other path: /<slug>/ redirects to the tool, the rest is the 404 page.

import { defineHandler } from "void"
import { notFoundPage } from "../src/app/handler.ts"
import { toolBySlug } from "../src/tools/index.ts"

export const GET = defineHandler((c) => {
  const url = new URL(c.req.url)
  const tool = toolBySlug(/^\/([^/]+)\/$/.exec(url.pathname)?.[1])
  if (tool) return Response.redirect(`${url.origin}/${tool.slug}${url.search}`, 301)
  return notFoundPage()
})
