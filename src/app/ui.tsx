// Small building blocks for tool forms and results.

import type { Child, Html } from "../jsx/jsx-runtime.ts"

export const Field = (props: {
  readonly label: string
  readonly name: string
  readonly value?: string | undefined
  readonly placeholder?: string
  readonly grow?: boolean
  readonly autofocus?: boolean
  readonly type?: "text" | "search" | "number"
}): Html => (
  <div class={props.grow ? "field grow" : "field"}>
    <label for={props.name}>{props.label}</label>
    <input
      type={props.type ?? "text"}
      id={props.name}
      name={props.name}
      value={props.value}
      placeholder={props.placeholder}
      autofocus={props.autofocus}
      autocomplete="off"
      spellcheck="false"
      autocapitalize="off"
    />
  </div>
)

export const Select = (props: {
  readonly label: string
  readonly name: string
  readonly value?: string | undefined
  readonly options: ReadonlyArray<readonly [value: string, label: string]>
}): Html => (
  <div class="field">
    <label for={props.name}>{props.label}</label>
    <select id={props.name} name={props.name}>
      {props.options.map(([value, label]) => <option value={value} selected={value === props.value}>{label}</option>)}
    </select>
  </div>
)

/** A checkbox that submits `value` when checked, and `off` via a hidden input when not. */
export const Check = (props: {
  readonly label: string
  readonly name: string
  readonly checked: boolean
}): Html => (
  <label class="check">
    <input type="hidden" name={props.name} value="off" />
    <input type="checkbox" name={props.name} value="on" checked={props.checked} />
    {props.label}
  </label>
)

export type Level = "ok" | "warn" | "bad"

/** A status line with a ✓, ! or ✕ in front. */
export const Status = (props: { readonly level: Level; readonly children?: Child }): Html => (
  <span class={`status ${props.level}`}>{props.children}</span>
)

/** Label/value pairs. Rows whose value is null or undefined are left out. */
export const KeyValue = (props: { readonly rows: ReadonlyArray<readonly [string, Child]> }): Html => (
  <dl class="kv">
    {props.rows.filter(([, v]) => v !== null && v !== undefined && v !== "").map(([k, v]) => [<dt>{k}</dt>, <dd>{v}</dd>])}
  </dl>
)

/** A table with a header row. */
export const Table = (props: {
  readonly head: ReadonlyArray<string>
  readonly rows: ReadonlyArray<ReadonlyArray<Child>>
}): Html => (
  <table>
    <thead>
      <tr>{props.head.map((h) => <th>{h}</th>)}</tr>
    </thead>
    <tbody>
      {props.rows.map((row) => <tr>{row.map((cell) => <td>{cell}</td>)}</tr>)}
    </tbody>
  </table>
)

/** Small facts above a result: "Status No error · 12 ms · Cloudflare". */
export const Summary = (props: { readonly items: ReadonlyArray<readonly [string, Child]> }): Html => (
  <p class="summary">{props.items.map(([k, v]) => <span>{k} <b>{v}</b></span>)}</p>
)
