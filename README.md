# tools

Network and email tools at [tools.mikepage.nl](https://tools.mikepage.nl):
DNS lookup and discovery, DMARC, SPF, RDAP, an SMTP submission test, IPv6,
browser and IP info, Cloudflare edge and a link scanner.

One Cloudflare Worker. Every tool is a server-rendered page and a JSON API.
No framework, no runtime dependencies, no compatibility flags. The web
platform is the standard library.

## Why

These tools started on Deno, moved to Hono (191 packages and
`nodejs_compat`), then to Effect (one package, but not built or tested for
workerd). This version uses what the Workers runtime already has:

| Need | Platform API |
| --- | --- |
| Routing | `URLPattern` |
| HTTP calls with timeouts | `fetch`, `AbortSignal.timeout` |
| DNS | DNS over HTTPS, which is `fetch` |
| HTML parsing | `HTMLRewriter` |
| SMTP | `connect` from `cloudflare:sockets` |
| Crypto | `crypto.subtle`, `crypto.randomUUID` |
| Formatting | `Intl` |
| Caching, rate limiting | the Cache API, the rate limiting binding |

The Worker is 50 KB gzipped and starts in about 14 ms of CPU. The Effect
version was 178 KB and about 46 ms.

What the platform doesn't have is small enough to write: input validation
([`src/lib/params.ts`](src/lib/params.ts)), a JSX runtime that renders HTML
strings ([`src/jsx/jsx-runtime.ts`](src/jsx/jsx-runtime.ts)), and two error
classes.

## How it's built

```
src/
  tools/     one file per tool: parse, run, and Form and Result views
  app/       routing, the page layout, components, the stylesheet
  lib/       shared pieces: DNS over HTTPS, fetch with timeouts, input
  jsx/       a JSX runtime that renders to HTML strings
  worker.ts  the Worker entry
cli/         the `tools` command line
test/        tests, run inside workerd
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

`cli/tools.ts` is built with UnJS [citty](https://github.com/unjs/citty) and
[consola](https://github.com/unjs/consola). They are the only dependencies,
and they never reach the Worker. The CLI reads `/api.json` and calls the
API:

```sh
npm run cli                                   # list the tools
npm run cli -- dns-lookup cloudflare.com --type MX
npm run cli -- dmarc-validator google.com --json
TOOLS_URL=http://localhost:8787 npm run cli -- ip-info
```

## Development

```sh
npm install
npm run dev      # wrangler dev on http://localhost:8787
npm test         # vitest, with the Worker running in workerd
npm run check    # tsc
npm run deploy
```

Tests start the Worker with Wrangler's test harness, inside workerd, the
runtime it runs on in production. They use live resolvers, registries and
mail servers.

## License

MIT
