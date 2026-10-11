# One tool, three platforms

The DNS lookup tool, written three times with the same parameters, the same
JSON result and the same error codes (400 for bad input, 502 when the
resolver fails):

- [`deno/main.ts`](deno/main.ts): Deno, the way it ran on Deno Deploy.
  `Deno.serve` and the standard library.
- [`hono/src/index.tsx`](hono/src/index.tsx): Hono and Zod on Cloudflare
  Workers, the way most Workers apps are written.
- [`../src/tools/dns-lookup.tsx`](../src/tools/dns-lookup.tsx): Effect on
  Cloudflare Workers, the version that runs on tools.mikepage.nl.

|                              | Deno             | Hono + Zod          | Effect             |
| ---------------------------- | ---------------- | ------------------- | ------------------ |
| Runtime packages             | 1 (`@std/html`)  | 2 (`hono`, `zod`)   | 1 (`effect`)       |
| Runs on Workers              | no               | yes                 | yes                |
| Query validation             | by hand          | Zod                 | Schema             |
| Resolver answer checked      | no               | Zod                 | Schema             |
| Timeout                      | `AbortSignal`    | `AbortSignal`       | `Effect.timeout`   |
| Errors                       | `try`/`catch`    | `try`/`catch`       | typed, in the type |

For one tool the package counts are close. The difference shows when the
app grows. The full Hono app this replaced had 5 direct dependencies and 191
packages: an MCP server, validation, routing and JSX each came from a
different project with its own release cycle. With Effect, HTTP, Schema,
config, caching, retries, a CLI, SQL, RPC and AI clients are one package, one
version, released together.

Deno's runtime gets one more year of fixes after the team joined Cloudflare,
and Deno Deploy shuts down. The Deno version is here as the reference it
was.
