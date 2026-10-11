// The contract every tool implements. A tool is a decoder for its query
// string, an Effect that computes a result, and two JSX views: the form and
// the result. The app turns that into a page at /<slug> and a JSON API at
// /<slug>/api; both run the same `params` + `run`.

import { Context, type Effect, Option, Schema } from "effect"
import type { HttpClient } from "effect/http"
import type { Html } from "../jsx/jsx-runtime.ts"

/** Sections of the overview, in display order. */
export const CATEGORIES = ["DNS & domains", "Email", "Network", "Web"] as const
export type Category = (typeof CATEGORIES)[number]

/** The query string, as decoded by `params`. Repeated keys keep the last value. */
export type Query = Readonly<Record<string, string>>

/** The input made sense to the decoder but not to the tool: a 400. */
export class InputError extends Schema.TaggedError<InputError>()("InputError", {
  message: Schema.String,
}) {}

/** A resolver, registry or server the tool depends on failed: a 502. */
export class UpstreamError extends Schema.TaggedError<UpstreamError>()("UpstreamError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/** Who is asking: the client's IP, request headers and Cloudflare's `cf` data. */
export class Visitor extends Context.Service<Visitor, {
  readonly ip: Option.Option<string>
  readonly headers: Headers
  readonly cf: Option.Option<Readonly<Record<string, unknown>>>
}>()("tools/Visitor") {
  static fromRequest(request: Request): Visitor["Service"] {
    const cf = (request as { cf?: Record<string, unknown> }).cf
    return {
      ip: Option.fromNullishOr(request.headers.get("cf-connecting-ip")),
      headers: request.headers,
      cf: Option.fromNullishOr(cf),
    }
  }
}

/** What `run` may use. */
export type Services = HttpClient.HttpClient | Visitor

export interface Tool<I, R> {
  readonly slug: string
  readonly title: string
  /** One sentence for the overview and the page header. */
  readonly summary: string
  readonly category: Category
  /** Decodes the query string. A failure is a 400 with the Schema's message. */
  readonly params: Schema.Decoder<I>
  /** Run with an empty query too (tools about the visitor, like IP info). */
  readonly autorun?: boolean
  readonly run: (input: I) => Effect.Effect<R, InputError | UpstreamError, Services>
  /** The form fields; the app wraps them in a GET form with a submit button. */
  readonly Form: (props: { readonly query: Query }) => Html
  readonly Result: (props: { readonly result: R; readonly input: I }) => Html
  /** Extra headers on the page and API responses, e.g. `Accept-CH` for Client Hints. */
  readonly responseHeaders?: Readonly<Record<string, string>>
  /** Example queries, shown under an empty form. */
  readonly examples: ReadonlyArray<{ readonly label: string; readonly query: string }>
}

export type AnyTool = Tool<any, any>

/** Declares a tool; the identity function, there for type inference. */
export const make = <I, R>(tool: Tool<I, R>): Tool<I, R> => tool
