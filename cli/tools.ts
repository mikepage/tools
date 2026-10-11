#!/usr/bin/env node
// The tools as a command line, built with UnJS citty (arguments) and consola
// (output). It reads the tool list from /api.json and calls each tool's JSON
// API, so it works against tools.mikepage.nl or a local `wrangler dev`.
//
//   tools                                   list the tools
//   tools dns-lookup cloudflare.com --type MX
//   tools dmarc-validator google.com --json
//   TOOLS_URL=http://localhost:8787 tools ip-info

import { inspect } from "node:util"
import { type ArgsDef, defineCommand, runMain } from "citty"
import { consola } from "consola"

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

// --url wins over TOOLS_URL; read before citty parses, because the
// subcommands come from the catalog.
const urlFlag = process.argv.indexOf("--url")
const base = (urlFlag > 0 ? process.argv[urlFlag + 1] : undefined) ?? process.env["TOOLS_URL"] ?? "https://tools.mikepage.nl"

const loadCatalog = async (): Promise<ReadonlyArray<CatalogEntry>> => {
  try {
    const response = await fetch(new URL("/api.json", base), { signal: AbortSignal.timeout(10_000) })
    if (!response.ok) throw new Error(`status ${response.status}`)
    return (await response.json()) as ReadonlyArray<CatalogEntry>
  } catch (error) {
    consola.error(`Could not load the tool list from ${base}: ${error instanceof Error ? error.message : error}`)
    process.exit(1)
  }
}

const toolCommand = (tool: CatalogEntry) => {
  // The first required parameter is also positional: `tools dns-lookup example.com`.
  const [primary] = Object.entries(tool.params).find(([, p]) => p.required) ?? []
  const args: ArgsDef = {
    json: { type: "boolean", description: "Print the raw JSON" },
    url: { type: "string", description: "Base URL of the tools Worker" },
  }
  if (primary) args["target"] = { type: "positional", required: false, description: tool.params[primary]!.description }
  for (const [name, param] of Object.entries(tool.params)) {
    const values = param.values ? ` (${param.values.join(", ")})` : ""
    args[name] = { type: "string", description: param.description + values, ...(param.default ? { default: param.default } : {}) }
  }
  return defineCommand({
    meta: { name: tool.slug, description: tool.summary },
    args,
    async run({ args: parsed }) {
      const query = new URLSearchParams()
      for (const name of Object.keys(tool.params)) {
        const value = parsed[name] ?? (name === primary ? parsed["target"] : undefined)
        if (typeof value === "string" && value !== "") query.set(name, value)
      }
      const url = new URL(`/${tool.slug}/api?${query}`, base)
      const response = await fetch(url, { signal: AbortSignal.timeout(60_000) })
      const body = (await response.json()) as Record<string, unknown>
      if (!response.ok) {
        consola.error(String(body["error"] ?? `status ${response.status}`))
        process.exit(1)
      }
      if (parsed["json"]) console.log(JSON.stringify(body, null, 2))
      else console.log(inspect(body, { depth: null, colors: process.stdout.isTTY, breakLength: 100 }))
    },
  })
}

const catalog = await loadCatalog()

const main = defineCommand({
  meta: { name: "tools", description: `Network and email tools (${base})` },
  args: { url: { type: "string", description: "Base URL of the tools Worker" } },
  subCommands: Object.fromEntries(catalog.map((tool) => [tool.slug, toolCommand(tool)])),
  run({ rawArgs }) {
    if (rawArgs.some((a) => catalog.some((t) => t.slug === a))) return
    const ORDER = ["DNS & domains", "Email", "Network", "Web"]
    const rank = (c: string) => (ORDER.indexOf(c) + 1 || ORDER.length + 1)
    const categories = [...new Set(catalog.map((t) => t.category))].sort((a, b) => rank(a) - rank(b))
    for (const category of categories) {
      consola.log(`\n${category}`)
      for (const tool of catalog.filter((t) => t.category === category)) consola.log(`  ${tool.slug.padEnd(24)} ${tool.summary}`)
    }
    consola.log(`\nRun \`tools <tool> --help\` for its options.`)
  },
})

await runMain(main)
