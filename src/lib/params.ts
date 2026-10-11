// Reading query parameters. Each helper returns a typed value or throws an
// InputError that names the parameter. Empty fields count as absent, so a
// submitted form with a blank field behaves like a URL without it.

import { InputError, type Query } from "../tools/Tool.ts"

/** The trimmed value, or undefined when absent or blank. */
export const optional = (query: Query, key: string): string | undefined => {
  const value = query[key]?.trim()
  return value ? value : undefined
}

export const required = (query: Query, key: string, example: string): string => {
  const value = optional(query, key)
  if (value === undefined) throw new InputError(`${key}: required, e.g. ${key}=${example}`)
  return value
}

/** One of `values`, compared case-insensitively; `fallback` when absent. */
export const oneOf = <const T extends string>(
  query: Query,
  key: string,
  values: ReadonlyArray<T>,
  fallback: T,
): T => {
  const value = optional(query, key)
  if (value === undefined) return fallback
  const match = values.find((v) => v.toLowerCase() === value.toLowerCase())
  if (match === undefined) throw new InputError(`${key}: expected one of ${values.join(", ")}`)
  return match
}

const ON = /^(1|true|on|yes)$/i
const OFF = /^(0|false|off|no|disabled?)$/i

/** A boolean flag: 1/true/on/yes or 0/false/off/no. */
export const flag = (query: Query, key: string, fallback: boolean): boolean => {
  const value = optional(query, key)
  if (value === undefined) return fallback
  if (ON.test(value)) return true
  if (OFF.test(value)) return false
  throw new InputError(`${key}: expected on or off`)
}

/** An integer within [min, max]. */
export const integer = (
  query: Query,
  key: string,
  options: { readonly min: number; readonly max: number; readonly fallback: number },
): number => {
  const value = optional(query, key)
  if (value === undefined) return options.fallback
  const n = Number(value)
  if (!Number.isInteger(n)) throw new InputError(`${key}: expected a whole number`)
  if (n < options.min || n > options.max) throw new InputError(`${key}: expected ${options.min} to ${options.max}`)
  return n
}
