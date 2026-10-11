// A JSX runtime that renders straight to HTML strings. No virtual DOM, no
// client runtime, no dependency: `<p>{name}</p>` becomes an `Html` value
// whose text is `<p>Ada</p>`, with every interpolated string escaped.

/** Rendered, trusted HTML. Strings are escaped; `Html` is inserted as is. */
export class Html {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value
  }
}

/** Anything a JSX expression may contain. */
export type Child = Html | string | number | bigint | boolean | null | undefined | ReadonlyArray<Child>

/** Inserts `html` without escaping. Only for markup you wrote yourself. */
export const raw = (html: string): Html => new Html(html)

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }

/** Escapes text for use in HTML content and attribute values. */
export const escape = (text: string): string => text.replace(/[&<>"']/g, (c) => ESCAPES[c]!)

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"])

const renderChild = (child: Child): string => {
  if (child === null || child === undefined || child === false || child === true) return ""
  if (child instanceof Html) return child.value
  if (Array.isArray(child)) return child.map(renderChild).join("")
  return escape(String(child))
}

const renderAttributes = (props: Record<string, unknown>): string => {
  let out = ""
  for (const [name, value] of Object.entries(props)) {
    if (name === "children" || value === null || value === undefined || value === false) continue
    out += value === true ? ` ${name}` : ` ${name}="${escape(String(value))}"`
  }
  return out
}

type Props = Record<string, unknown> & { readonly children?: Child }
type Component = (props: any) => Html

/** Called by the compiler for every JSX element. */
export const jsx = (type: string | Component, props: Props): Html => {
  if (typeof type === "function") return type(props)
  const attributes = renderAttributes(props)
  if (VOID.has(type)) return new Html(`<${type}${attributes}>`)
  return new Html(`<${type}${attributes}>${renderChild(props.children)}</${type}>`)
}

export const jsxs = jsx
export const jsxDEV = jsx

/** `<>...</>` */
export const Fragment = (props: { readonly children?: Child }): Html => new Html(renderChild(props.children))

export declare namespace JSX {
  type Element = Html
  interface ElementChildrenAttribute {
    children: {}
  }
  interface IntrinsicElements {
    [tag: string]: Record<string, unknown> & { children?: Child }
  }
}
