// The contract every tool implements: a parser for its query string, an
// async run, and two JSX views. The app turns that into a page at /<slug>
// and a JSON API at /<slug>/api; both use the same `parse` and `run`.
// Plain web platform: no framework, no runtime dependencies.

import type { Html } from "../jsx/jsx-runtime.ts"

/** Sections of the overview, in display order. */
export const CATEGORIES = ["DNS & domains", "Email", "Network", "Web"] as const
export type Category = (typeof CATEGORIES)[number]

/** The query string. Repeated keys keep the last value. */
export type Query = Readonly<Record<string, string>>

/** Bad input: a 400. The message says which parameter and why. */
export class InputError extends Error {
  override readonly name = "InputError"
}

/** A resolver, registry or server the tool depends on failed: a 502. */
export class UpstreamError extends Error {
  override readonly name = "UpstreamError"
}

/** Who is asking: the client's IP, the request headers and Cloudflare's `cf` data. */
export interface Visitor {
  readonly ip: string | undefined
  readonly headers: Headers
  readonly cf: Readonly<Record<string, unknown>> | undefined
}

export const visitorFrom = (request: Request): Visitor => ({
  ip: request.headers.get("cf-connecting-ip") ?? undefined,
  headers: request.headers,
  cf: (request as { cf?: Record<string, unknown> }).cf,
})

/** One query parameter, for the API catalog and the CLI. */
export interface Param {
  readonly description: string
  readonly required?: boolean
  readonly default?: string
  readonly values?: ReadonlyArray<string>
}

export interface Tool<I, R> {
  readonly slug: string
  readonly title: string
  /** One sentence for the overview and the page header. */
  readonly summary: string
  readonly category: Category
  /** The query parameters, documented. `parse` is the source of truth. */
  readonly params: Readonly<Record<string, Param>>
  /** Turns the query string into the tool's input, or throws an InputError. */
  readonly parse: (query: Query, visitor: Visitor) => I
  /** Runs the tool. Throws InputError (400) or UpstreamError (502); anything else is a bug (500). */
  readonly run: (input: I, visitor: Visitor) => Promise<R>
  /** Run with an empty query too (tools about the visitor, like IP info). */
  readonly autorun?: boolean
  /** The form fields; the app wraps them in a GET form with a submit button. */
  readonly Form: (props: { readonly query: Query }) => Html
  readonly Result: (props: { readonly result: R; readonly input: I }) => Html
  /** Extra headers on the page and API responses, e.g. `Accept-CH`. */
  readonly responseHeaders?: Readonly<Record<string, string>>
  /** Example queries, shown under an empty form. */
  readonly examples: ReadonlyArray<{ readonly label: string; readonly query: string }>
}

export type AnyTool = Tool<any, any>

/** Declares a tool; the identity function, there for type inference. */
export const make = <I, R>(tool: Tool<I, R>): Tool<I, R> => tool
