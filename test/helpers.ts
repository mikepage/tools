// Runs the Worker inside workerd for tests, through Wrangler's test harness:
// the same runtime and bundler as production, no compatibility flags.
// `startWorker()` serves every tool; `startWorker({ module, export })` serves
// one tool on its own.

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createTestHarness } from "wrangler"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const OUT = join(ROOT, ".test-build")

export interface TestWorker {
  /** Sends a GET and returns status, headers and body text. */
  readonly get: (
    path: string,
    init?: { readonly headers?: Record<string, string>; readonly cf?: Record<string, unknown> },
  ) => Promise<{ status: number; headers: Headers; text: string }>
  readonly dispose: () => Promise<void>
}

export const startWorker = async (tool?: { readonly module: string; readonly export: string }): Promise<TestWorker> => {
  let configPath = join(ROOT, "wrangler.test.jsonc")
  if (tool) {
    mkdirSync(OUT, { recursive: true })
    const entry = join(OUT, `${tool.export}.entry.ts`)
    writeFileSync(
      entry,
      [
        `import { makeHandler } from ${JSON.stringify(join(ROOT, "src/app/handler.ts"))}`,
        `import { ${tool.export} as tool } from ${JSON.stringify(join(ROOT, tool.module))}`,
        `const handle = makeHandler([tool])`,
        `export default { fetch: (request: Request) => handle(request) }`,
      ].join("\n"),
    )
    configPath = join(OUT, `${tool.export}.wrangler.jsonc`)
    writeFileSync(configPath, JSON.stringify({ name: `test-${tool.export.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`, main: entry, compatibility_date: "2026-09-30" }))
  }
  const harness = createTestHarness({ root: ROOT, workers: [{ configPath }] })
  await harness.listen()
  return {
    get: async (path, init = {}) => {
      const response = await harness.fetch(`https://tools.test${path}`, {
        headers: init.headers ?? {},
        ...(init.cf ? { cf: init.cf } : {}),
        redirect: "manual",
      })
      return { status: response.status, headers: response.headers as unknown as Headers, text: await response.text() }
    },
    dispose: () => harness.close(),
  }
}
