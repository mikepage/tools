#!/usr/bin/env node
// The tools as a command line, on Node alone: `parseArgs` from node:util
// for the arguments, the console for output. It reads the tool list from
// /api.json and calls each tool's JSON API, so it works against
// tools.mikepage.workers.dev or a local `void dev`.
//
//   tools                                   list the tools
//   tools dns-lookup cloudflare.com --type MX
//   tools dmarc-validator google.com --json
//   TOOLS_URL=http://localhost:5173 tools ip-info

import { inspect, parseArgs, styleText } from "node:util"

interface Param {
  readonly description: string
  readonly required?: boolean
  readonly default?: string
  readonly values?: ReadonlyArray<string>
}

interface CatalogEntry {
  readonly slug: string
  readonly title: string
  readonly summary: string
  readonly category: string
  readonly params: Readonly<Record<string, Param>>
}

// Piping into `head` closes stdout early; that is not an error.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(0)
  throw error
})

const fail = (message: string): never => {
  console.error(styleText("red", `✖ ${message}`))
  process.exit(1)
}

// The first pass only finds --url and the tool; each tool's own flags come
// from the catalog, so they are parsed once it has loaded.
const { values: global, positionals } = parseArgs({
  options: { url: { type: "string" }, help: { type: "boolean", short: "h" } },
  strict: false,
  allowPositionals: true,
})
const base = (typeof global.url === "string" ? global.url : undefined) ?? process.env["TOOLS_URL"] ?? "https://tools.mikepage.workers.dev"

const loadCatalog = async (): Promise<ReadonlyArray<CatalogEntry>> => {
  try {
    const response = await fetch(new URL("/api.json", base), { signal: AbortSignal.timeout(10_000) })
    if (!response.ok) throw new Error(`status ${response.status}`)
    return (await response.json()) as ReadonlyArray<CatalogEntry>
  } catch (error) {
    return fail(`Could not load the tool list from ${base}: ${error instanceof Error ? error.message : error}`)
  }
}

const ORDER = ["DNS & domains", "Email", "Network", "Web"]

const list = (catalog: ReadonlyArray<CatalogEntry>) => {
  console.log(`tools: network and email tools (${base})`)
  const rank = (c: string) => (ORDER.indexOf(c) + 1 || ORDER.length + 1)
  const categories = [...new Set(catalog.map((t) => t.category))].sort((a, b) => rank(a) - rank(b))
  for (const category of categories) {
    console.log(`\n${styleText("bold", category)}`)
    for (const tool of catalog.filter((t) => t.category === category)) console.log(`  ${tool.slug.padEnd(24)} ${tool.summary}`)
  }
  console.log(`\nRun \`tools <tool> --help\` for its options.`)
}

const usage = (tool: CatalogEntry, primary: string | undefined) => {
  console.log(`${tool.summary}\n\nUsage: tools ${tool.slug}${primary ? ` [${primary}]` : ""} [options]\n`)
  for (const [name, param] of Object.entries(tool.params)) {
    const values = param.values ? ` (${param.values.join(", ")})` : ""
    const fallback = param.default ? ` [default: ${param.default}]` : ""
    console.log(`  --${name.padEnd(20)} ${param.description}${values}${fallback}`)
  }
  console.log(`  --${"json".padEnd(20)} Print the raw JSON`)
  console.log(`  --${"url".padEnd(20)} Base URL of the tools Worker`)
}

const run = async (tool: CatalogEntry) => {
  // The first required parameter is also positional: `tools dns-lookup example.com`.
  const [primary] = Object.entries(tool.params).find(([, p]) => p.required) ?? []
  const { values, positionals: rest } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== tool.slug),
    options: {
      ...Object.fromEntries(Object.keys(tool.params).map((name) => [name, { type: "string" as const }])),
      json: { type: "boolean" },
      url: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  })
  if (values.help) return usage(tool, primary)

  const flags = values as Readonly<Record<string, string | boolean | undefined>>
  const query = new URLSearchParams()
  for (const [name, param] of Object.entries(tool.params)) {
    const value = flags[name] ?? (name === primary ? rest[0] : undefined) ?? param.default
    if (typeof value === "string" && value !== "") query.set(name, value)
  }
  const response = await fetch(new URL(`/${tool.slug}/api?${query}`, base), { signal: AbortSignal.timeout(60_000) })
  const body = (await response.json()) as Record<string, unknown>
  if (!response.ok) fail(String(body["error"] ?? `status ${response.status}`))
  if (values.json) console.log(JSON.stringify(body, null, 2))
  else console.log(inspect(body, { depth: null, colors: process.stdout.isTTY, breakLength: 100 }))
}

const catalog = await loadCatalog()
const tool = catalog.find((t) => t.slug === positionals[0])
if (tool) await run(tool)
else if (positionals[0]) fail(`Unknown tool: ${positionals[0]}. Run \`tools\` for the list.`)
else list(catalog)
