// Domain input: people paste URLs, trailing dots and mixed case.

import { Schema, SchemaTransformation } from "effect"

const LABEL = /^_?[a-z0-9]([a-z0-9-_]{0,61}[a-z0-9])?$/i

/** Strips a scheme, path, port, `www.`-less; keeps the host, lowercased. */
export const cleanDomain = (input: string): string => {
  let s = input.trim().toLowerCase()
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
  s = s.split(/[/?#]/)[0] ?? ""
  s = s.replace(/:\d+$/, "").replace(/\.$/, "")
  return s
}

export const isDomain = (name: string): boolean => {
  const labels = name.split(".")
  return name.length <= 253 && labels.length >= 2 && labels.every((l) => LABEL.test(l))
}

/** A domain or DNS name (labels may start with `_`), cleaned up while decoding. */
export const Domain = Schema.String.pipe(
  Schema.decode(SchemaTransformation.transform({ decode: cleanDomain, encode: (s) => s })),
  Schema.check(Schema.makeFilter(isDomain, { expected: "a domain such as example.com" })),
)
