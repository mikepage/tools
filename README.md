# tools

Network and email tools at [tools.mikepage.nl](https://tools.mikepage.nl):
DNS lookup and discovery, DMARC, SPF, RDAP, an SMTP submission test, IPv6,
browser and IP info, Cloudflare edge, a link scanner and a phone number
validator.

One Cloudflare Worker. Every tool is a server-rendered page and a JSON API.
Built on [Effect](https://effect.website), with no compatibility flags and
two runtime packages: `effect`, and `libphonenumber-js` for the phone tool.

## Why

To show that a Worker can host a proper app, and that Effect is a proper
framework for one. Routing, validation, HTTP clients, timeouts, retries,
typed errors and services all come from one package with no dependencies of
its own, released as one version. The previous version of these tools ran
on Hono and needed 191 packages and `nodejs_compat`.

[`comparison/`](comparison/README.md) has the DNS lookup written three ways:
for Deno, for Hono with Zod, and with Effect.

## How it's built

```
src/
  tools/     one file per tool: input Schema, run Effect, Form and Result views
  app/       routing, the page layout, components, the stylesheet
  lib/       shared pieces: DNS over HTTPS, domain input, IP helpers
  jsx/       a JSX runtime that renders to HTML strings
  worker.ts  the Worker entry
```

A tool is a value of type `Tool` ([`src/tools/Tool.ts`](src/tools/Tool.ts)):

- `params`: a Schema that decodes the query string into the tool's input.
  Bad input is a 400 with the Schema's message.
- `run`: an Effect from input to result. It fails with `InputError` (400) or
  `UpstreamError` (502), and those types are in its signature.
- `Form` and `Result`: JSX views.

The app serves `/<slug>` (the page) and `/<slug>/api` (JSON) from the same
`params` and `run`. There is no client-side JavaScript.

The JSX runtime ([`src/jsx/jsx-runtime.ts`](src/jsx/jsx-runtime.ts)) is
about 70 lines. It escapes every interpolated string and has no virtual DOM.

## Development

```sh
npm install
npm run dev      # wrangler dev on http://localhost:8787
npm test         # vitest, through the real handler
npm run check    # tsc
npm run deploy
```

Tests run in Node against live resolvers and registries. The SMTP test needs
`cloudflare:sockets`, so its live path only runs on Workers (`npm run dev`).

## License

MIT
