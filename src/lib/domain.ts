// Domain input: people paste URLs, trailing dots and mixed case.

import { InputError, type Query } from "../tools/Tool.ts"
import { required } from "./params.ts"

const LABEL = /^_?[a-z0-9]([a-z0-9-_]{0,61}[a-z0-9])?$/i

/** Strips a scheme, path and port; keeps the host, lowercased. */
export const cleanDomain = (input: string): string => {
  let s = input.trim().toLowerCase()
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
  s = s.split(/[/?#]/)[0] ?? ""
  s = s.replace(/:\d+$/, "").replace(/\.$/, "")
  return s
}

/** A domain or DNS name; labels may start with `_` (`_dmarc.example.com`). */
export const isDomain = (name: string): boolean => {
  const labels = name.split(".")
  return name.length <= 253 && labels.length >= 2 && labels.every((l) => LABEL.test(l))
}

/** Reads a domain parameter (or the first of several aliases), cleaned up. Throws InputError. */
export const domainParam = (query: Query, keys: ReadonlyArray<string>, example = "example.com"): string => {
  const key = keys.find((k) => query[k]?.trim()) ?? keys[0]!
  const domain = cleanDomain(required(query, key, example))
  if (!isDomain(domain)) throw new InputError(`${key}: expected a domain such as ${example}`)
  return domain
}
