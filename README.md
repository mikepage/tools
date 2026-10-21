# tools

Network and email tools at [tools.mikepage.workers.dev](https://tools.mikepage.workers.dev):
DNS lookup and discovery, DMARC, SPF, RDAP, an SMTP submission test, IPv6,
browser and IP info, Cloudflare edge and a link scanner.

One Cloudflare Worker, built and deployed with [Void](https://void.cloud).
Every tool is a server-rendered page and a JSON API. The tools themselves
use the web platform and nothing else; Void adds the file-based routes, the
build and the deploy.

## Why

These tools started on Deno, moved to Hono (191 packages and
`nodejs_compat`), then to Effect (one package, but not built or tested for
workerd), then to the bare Workers runtime with no packages at all. They now
run on Void, the Vite-based framework from VoidZero, which joined Cloudflare
in June. The tools still use what the Workers runtime already has:

| Need | Platform API |
| --- | --- |
| Routing | Void's `routes/`, one file per URL |
| HTTP calls with timeouts | `fetch`, `AbortSignal.timeout` |
| DNS | DNS over HTTPS, which is `fetch` |
| HTML parsing | `HTMLRewriter` |
| SMTP | `connect` from `cloudflare:sockets` |
| Crypto | `crypto.subtle`, `crypto.randomUUID` |
| Formatting | `Intl` |
| Caching, rate limiting | the Cache API, the rate limiting binding |

The Worker is about 68 KB gzipped. The bare Workers version was 50 KB, the
Effect version 178 KB.

What the platform doesn't have is small enough to write: input validation
([`src/lib/params.ts`](src/lib/params.ts)), a JSX runtime that renders HTML
strings ([`src/jsx/jsx-runtime.ts`](src/jsx/jsx-runtime.ts)), and two error
classes.

## How it's built

```
routes/          one Void route per URL: /, /styles.css, /api.json,
                 /[slug], /[slug]/api, and a catch-all 404
middleware/      the rate limit on tool runs
src/
  tools/         one file per tool: parse, run, and Form and Result views
  app/           responses, the page layout, components, the stylesheet
  lib/           shared pieces: DNS over HTTPS, fetch with timeouts, input
  jsx/           a JSX runtime that renders to HTML strings
cli/             the `tools` command line
test/            tests, run inside workerd
void.config.ts   the Worker's name, rate limit and custom domain
```

A tool is a value of type `Tool` ([`src/tools/Tool.ts`](src/tools/Tool.ts)):

- `parse` turns the query string into the tool's input. Bad input throws an
  `InputError`: a 400 that names the parameter.
- `run` computes the result. A failing resolver, registry or server throws
  an `UpstreamError`: a 502. Anything else is a bug: a 500.
- `params` documents the query parameters.
- `Form` and `Result` are JSX views.

The app serves `/<slug>` (the page) and `/<slug>/api` (JSON) from the same
`parse` and `run`, and `/api.json` lists every tool with its parameters.
There is no client-side JavaScript.

## Command line

`cli/tools.ts` runs on Node alone: `parseArgs` from `node:util` for the
arguments, the console for output. It has no dependencies. It reads
`/api.json` and calls the API:

```sh
npm run cli                                   # list the tools
npm run cli -- dns-lookup cloudflare.com --type MX
npm run cli -- dmarc-validator google.com --json
TOOLS_URL=http://localhost:5173 npm run cli -- ip-info
```

## Development

```sh
npm install
npm run dev      # vite dev with Void on http://localhost:5173
npm test         # builds the app, then vitest with the Worker in workerd
npm run check    # tsc
npm run deploy   # void deploy
```

Tests build the app with Vite first, then start the built Worker with
Wrangler's test harness, inside workerd, the runtime it runs on in
production. The per-tool tests serve one tool on its own. They use live
resolvers, registries and mail servers.

## License

MIT
