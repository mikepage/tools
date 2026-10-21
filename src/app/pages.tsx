// The overview and the page every tool gets: header, form, result or error,
// and the matching API URL.

import type { Html } from "../jsx/jsx-runtime.ts"
import { CATEGORIES, type AnyTool, type Query } from "../tools/Tool.ts"
import { Layout } from "./layout.tsx"

const queryString = (query: Query): string => new URLSearchParams(query as Record<string, string>).toString()

export const Home = (props: { readonly tools: ReadonlyArray<AnyTool> }): Html => (
  <Layout title="tools" description="Network and email tools: DNS, DMARC, SPF, RDAP, SMTP, IPv6 and more.">
    <h1>tools</h1>
    <p class="lede">
      Network and email tools. Every tool is a page and a JSON API, in one Cloudflare Worker, built with Void on
      the web platform. <a href="https://github.com/mikepage/tools">How it's built</a>
    </p>
    {CATEGORIES.map((category) => {
      const list = props.tools.filter((t) => t.category === category)
      return list.length === 0 ? null : [
        <h2>{category}</h2>,
        <ul class="index">
          {list.map((t) => (
            <li>
              <a href={`/${t.slug}`}>{t.title}</a>
              <span>{t.summary}</span>
            </li>
          ))}
        </ul>,
      ]
    })}
  </Layout>
)

export type Outcome =
  | { readonly _tag: "Empty" }
  | { readonly _tag: "Failed"; readonly message: string }
  | { readonly _tag: "Done"; readonly input: unknown; readonly result: unknown }

export const ToolPage = (props: {
  readonly tool: AnyTool
  readonly query: Query
  readonly outcome: Outcome
}): Html => {
  const { tool, query, outcome } = props
  const qs = queryString(query)
  const apiPath = `/${tool.slug}/api${qs ? `?${qs}` : ""}`
  return (
    <Layout title={`${tool.title} · tools`} description={tool.summary}>
      <div class="eyebrow"><a href="/">tools</a> / {tool.category}</div>
      <h1>{tool.title}</h1>
      <p class="lede">{tool.summary}</p>
      <form class="tool" method="get" action={`/${tool.slug}`}>
        <tool.Form query={query} />
        <button type="submit">Run</button>
      </form>
      {outcome._tag === "Empty" && tool.examples.length > 0
        ? (
          <p class="examples">
            Try {tool.examples.map((e) => <a href={`/${tool.slug}?${e.query}`}>{e.label}</a>)}
          </p>
        )
        : null}
      {outcome._tag === "Failed"
        ? <div class="notice bad"><strong>Error</strong> {outcome.message}</div>
        : null}
      {outcome._tag === "Done"
        ? <section class="result"><tool.Result result={outcome.result} input={outcome.input} /></section>
        : null}
      <p class="api">
        JSON: <a href={apiPath}><code>{apiPath}</code></a>
      </p>
    </Layout>
  )
}

export const NotFound = (): Html => (
  <Layout title="Not found · tools" description="Not found">
    <h1>Not found</h1>
    <p class="lede">
      There is no tool here. <a href="/">All tools</a>
    </p>
  </Layout>
)
