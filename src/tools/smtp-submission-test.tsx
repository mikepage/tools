// SMTP submission test: a mail server's submission port over raw TCP. Reads
// the banner, sends EHLO, upgrades with STARTTLS when offered (implicit TLS on
// 465), sends EHLO again and returns the capabilities with the transcript.
//
// `cloudflare:sockets` is imported inside the Effect, so this module loads in
// Node too (for tests of the validation and the SSRF guard).

import { Clock, Duration, Effect, Schema, SchemaTransformation } from "effect"
import { Field, type Level, Select, Status, Summary, Table } from "../app/ui.tsx"
import * as Doh from "../lib/doh.ts"
import { isDomain } from "../lib/domain.ts"
import * as Tool from "./Tool.ts"

export const PORTS = [587, 465, 2525] as const
const TIMEOUT = Duration.seconds(8)
const EHLO_NAME = "tools.mikepage.nl"

// --- Input ----------------------------------------------------------------------

const blank = (s: string | undefined) => (s === undefined || s.trim() === "" ? undefined : s)

// IP literals are refused: a literal would skip the DNS check below.
const Host = Schema.String.pipe(
  Schema.decode(SchemaTransformation.transform({ decode: (s) => s.trim().toLowerCase().replace(/\.$/, ""), encode: (s) => s })),
  Schema.check(
    Schema.makeFilter((host: string) =>
      /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")
        ? "IP addresses are not accepted, enter a hostname"
        : isDomain(host) || "invalid hostname"
    ),
  ),
)

// Port 25 is not on the list: Workers cannot open it.
const Port = Schema.FiniteFromString.pipe(
  Schema.check(Schema.makeFilter((p: number) => (PORTS as ReadonlyArray<number>).includes(p) || "port must be 587, 465, or 2525")),
)

const Params = Schema.Struct({
  host: Schema.optional(Schema.String),
  port: Schema.optional(Schema.String),
}).pipe(
  Schema.decodeTo(
    Schema.Struct({ host: Host, port: Port }),
    SchemaTransformation.transform({
      decode: (q) => ({ host: blank(q.host) ?? "", port: blank(q.port) ?? "587" }),
      encode: (i) => i,
    }),
  ),
)
type Input = typeof Params.Type

// --- Result ---------------------------------------------------------------------

export interface LogEntry {
  /** Milliseconds since the probe started. */
  readonly t: number
  readonly direction: "sent" | "received" | "info" | "error"
  readonly message: string
}

export interface Result {
  readonly success: boolean
  readonly host: string
  readonly port: number
  readonly protocol: "implicit-tls" | "starttls"
  readonly greeting?: string
  /** EHLO capabilities, after the TLS upgrade when there was one. */
  readonly capabilities: ReadonlyArray<string>
  /** EHLO capabilities before STARTTLS (only when an upgrade happened). */
  readonly plaintextCapabilities?: ReadonlyArray<string>
  readonly tlsUpgraded: boolean
  readonly error?: string
  readonly logs: ReadonlyArray<LogEntry>
}

// --- SSRF guard -----------------------------------------------------------------
// Resolve A and AAAA right before connecting and refuse private, loopback,
// link-local and reserved ranges. Resolving just before the connect narrows
// the window for DNS rebinding.

export const isPrivateIPv4 = (ip: string): boolean => {
  const p = ip.split(".").map(Number)
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const [a = 0, b = 0, c = 0] = p
  return a === 0 || a === 10 || a === 127 || // this host, private, loopback
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 168) || // private
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // IETF protocol assignments, TEST-NET-1
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3
    a >= 224 // multicast, reserved, broadcast
}

export const isPrivateIPv6 = (ip: string): boolean => {
  const h = ip.toLowerCase()
  if (h === "::1" || h === "::") return true
  if (/^fe[89ab]/.test(h)) return true // fe80::/10 link-local
  if (h.startsWith("fc") || h.startsWith("fd")) return true // fc00::/7 unique local
  if (h.startsWith("ff")) return true // multicast
  if (h.startsWith("2001:db8:") || h.startsWith("2001:0db8:")) return true // documentation
  const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/) // IPv4-mapped
  return mapped ? isPrivateIPv4(mapped[1]!) : false
}

export const isPrivateAddress = (ip: string): boolean => (ip.includes(":") ? isPrivateIPv6(ip) : isPrivateIPv4(ip))

const addresses = (host: string, type: "A" | "AAAA") =>
  Doh.query(host, type, { timeout: TIMEOUT }).pipe(
    Effect.map(({ response }) => Doh.answersOf(response, type === "A" ? 1 : 28).map((a) => a.data)),
  )

export const assertPublicHost = Effect.fnUntraced(function*(host: string) {
  const [a, aaaa] = yield* Effect.all([addresses(host, "A"), addresses(host, "AAAA")], { concurrency: 2 })
  const all = [...a, ...aaaa]
  if (all.length === 0) return yield* new Tool.InputError({ message: `${host} does not resolve to any address.` })
  if (all.some(isPrivateAddress)) {
    return yield* new Tool.InputError({ message: `${host} resolves to a private or reserved address.` })
  }
})

// --- The SMTP session -----------------------------------------------------------

/** Something went wrong on the connection; the probe reports it as its result. */
class SmtpError extends Schema.TaggedError<SmtpError>()("SmtpError", { message: Schema.String }) {}

type Log = (direction: LogEntry["direction"], message: string) => Effect.Effect<void>

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e))

// Runs `effect` with the probe's timeout; a timeout is an SmtpError too.
const timed = <A, E>(effect: Effect.Effect<A, E>, what: string) =>
  Effect.timeoutOrElse(effect, {
    duration: TIMEOUT,
    orElse: () => Effect.fail(new SmtpError({ message: `${what} timed out after ${Duration.toSeconds(TIMEOUT)} s` })),
  })

const awaitOpened = (socket: Socket, what: string) =>
  timed(Effect.tryPromise({ try: () => socket.opened, catch: (e) => new SmtpError({ message: `${what} failed: ${reason(e)}` }) }), what)

// A line-oriented SMTP session over one socket (one per TLS layer), logging
// every line both ways.
const session = (socket: Socket, log: Log) => {
  const reader = socket.readable.getReader()
  const writer = socket.writable.getWriter()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buf = ""

  // Reads reply lines until the final "NNN " line (a space, not a dash).
  const read = (what: string) =>
    timed(
      Effect.gen(function*() {
        const lines: Array<string> = []
        while (true) {
          let i: number
          while ((i = buf.indexOf("\r\n")) !== -1) {
            const line = buf.slice(0, i)
            buf = buf.slice(i + 2)
            lines.push(line)
            yield* log("received", line)
            if (/^\d{3}( |$)/.test(line)) return lines
          }
          const { value, done } = yield* Effect.tryPromise({
            try: () => reader.read(),
            catch: (e) => new SmtpError({ message: `read failed: ${reason(e)}` }),
          })
          if (done) return yield* new SmtpError({ message: `connection closed while waiting for ${what}` })
          buf += decoder.decode(value, { stream: true })
        }
      }),
      what,
    )

  const send = (line: string) =>
    log("sent", line).pipe(
      Effect.andThen(Effect.tryPromise({
        try: () => writer.write(encoder.encode(`${line}\r\n`)),
        catch: (e) => new SmtpError({ message: `write failed: ${reason(e)}` }),
      })),
    )

  // Hands the socket back, before startTls() takes it over.
  const release = Effect.sync(() => {
    reader.releaseLock()
    writer.releaseLock()
  })

  return { read, send, release }
}

/** The first EHLO line is "250-hostname greeting"; the rest are capabilities. */
export const capabilitiesOf = (lines: ReadonlyArray<string>): Array<string> =>
  lines.slice(1).filter((l) => l.startsWith("250")).map((l) => l.slice(4).trim()).filter(Boolean)

const hasCapability = (caps: ReadonlyArray<string>, name: string) => caps.some((c) => c.toUpperCase().split(" ")[0] === name)

export const probe = Effect.fnUntraced(function*(host: string, port: number) {
  const started = yield* Clock.currentTimeMillis
  const logs: Array<LogEntry> = []
  const log: Log = (direction, message) =>
    Effect.map(Clock.currentTimeMillis, (now) => {
      logs.push({ t: now - started, direction, message })
    })
  const implicit = port === 465
  const result: { -readonly [K in keyof Result]: Result[K] } = {
    success: false,
    host,
    port,
    protocol: implicit ? "implicit-tls" : "starttls",
    capabilities: [],
    tlsUpgraded: implicit,
    logs,
  }

  // Imported here so the module loads outside the Workers runtime.
  const { connect } = yield* Effect.tryPromise({
    try: () => import("cloudflare:sockets"),
    catch: () => new Tool.UpstreamError({ message: "TCP sockets are only available on Cloudflare Workers." }),
  })

  const conversation = Effect.gen(function*() {
    yield* log("info", `Connecting to ${host}:${port}${implicit ? " with implicit TLS" : ""}`)
    // The socket is a resource: whatever happens below (a failure, a timeout,
    // an interruption), the scope closes it. `current` follows the STARTTLS
    // upgrade, which replaces the socket.
    const conn = yield* Effect.acquireRelease(
      Effect.try({
        try: () => ({
          current: connect({ hostname: host, port }, { secureTransport: implicit ? "on" : "starttls", allowHalfOpen: false }),
        }),
        catch: (e) => new SmtpError({ message: `connect failed: ${reason(e)}` }),
      }),
      (conn) => Effect.promise(() => conn.current.close().catch(() => {})),
    )
    yield* awaitOpened(conn.current, "TCP connect")
    yield* log("info", implicit ? "Connected, TLS handshake done" : "Connected")
    let s = session(conn.current, log)

    result.greeting = (yield* s.read("greeting")).join("\n")
    yield* s.send(`EHLO ${EHLO_NAME}`)
    result.capabilities = capabilitiesOf(yield* s.read("EHLO reply"))

    if (!implicit && hasCapability(result.capabilities, "STARTTLS")) {
      yield* s.send("STARTTLS")
      const [reply = ""] = yield* s.read("STARTTLS reply")
      if (!reply.startsWith("220")) return yield* new SmtpError({ message: `STARTTLS rejected: ${reply}` })
      yield* log("info", "Upgrading to TLS")
      yield* s.release
      conn.current = conn.current.startTls({ expectedServerHostname: host })
      yield* awaitOpened(conn.current, "TLS handshake")
      yield* log("info", "TLS handshake done")
      s = session(conn.current, log)
      result.tlsUpgraded = true
      result.plaintextCapabilities = result.capabilities
      // Servers often advertise different capabilities (typically AUTH) once TLS is up.
      yield* s.send(`EHLO ${EHLO_NAME}`)
      result.capabilities = capabilitiesOf(yield* s.read("EHLO reply after TLS"))
    }

    yield* s.send("QUIT")
    yield* Effect.ignore(s.read("QUIT reply"))
    result.success = true
  }).pipe(Effect.scoped)

  // A failed probe is still a result: the transcript shows where it broke.
  yield* conversation.pipe(
    Effect.catchTag("SmtpError", (error) => {
      result.error = error.message
      return log("error", error.message)
    }),
  )
  return result as Result
})

export const test = Effect.fnUntraced(function*(input: Input) {
  yield* assertPublicHost(input.host)
  return yield* probe(input.host, input.port)
})

// --- Views ----------------------------------------------------------------------

const Form = ({ query }: { readonly query: Tool.Query }) => (
  <>
    <Field label="Mail server" name="host" value={query["host"]} placeholder="smtp.example.com" grow autofocus />
    <Select
      label="Port"
      name="port"
      value={query["port"] ?? "587"}
      options={[["587", "587 (STARTTLS)"], ["465", "465 (implicit TLS)"], ["2525", "2525 (STARTTLS)"]]}
    />
  </>
)

const CAPABILITIES: Record<string, string> = {
  STARTTLS: "upgrade to TLS",
  AUTH: "login mechanisms",
  SIZE: "maximum message size",
  PIPELINING: "send commands in batches",
  "8BITMIME": "8-bit message bodies",
  SMTPUTF8: "UTF-8 addresses",
  ENHANCEDSTATUSCODES: "detailed status codes",
  CHUNKING: "BDAT transfers",
  DSN: "delivery status notifications",
  REQUIRETLS: "can require TLS onward",
}

const capabilityMeaning = (cap: string): string => {
  const [name = "", ...args] = cap.split(" ")
  if (name.toUpperCase() === "SIZE" && args[0]) return `maximum message size ${Math.round(Number(args[0]) / 1048576)} MB`
  return CAPABILITIES[name.toUpperCase()] ?? ""
}

const Checks = ({ result }: { readonly result: Result }) => {
  const items: Array<readonly [Level, string]> = []
  if (result.error) items.push(["bad", `Failed: ${result.error}`])
  if (result.protocol === "implicit-tls" && result.greeting !== undefined) items.push(["ok", "TLS from the first byte (implicit TLS)."])
  if (result.protocol === "starttls" && result.tlsUpgraded) items.push(["ok", "STARTTLS offered and the TLS upgrade worked."])
  if (result.protocol === "starttls" && !result.tlsUpgraded && result.capabilities.length > 0) {
    items.push(["bad", "No STARTTLS: credentials would cross the wire in the clear."])
  }
  const auth = result.capabilities.find((c) => c.toUpperCase().startsWith("AUTH"))
  if (auth) items.push(["ok", `Login offered: ${auth.slice(5).trim() || "AUTH"}.`])
  else if (result.success) items.push(["warn", "No AUTH offered, so clients cannot log in on this port."])
  return <ul class="plain">{items.map(([level, text]) => <li><Status level={level}>{text}</Status></li>)}</ul>
}

const ARROWS: Record<LogEntry["direction"], string> = { sent: "→", received: "←", info: "·", error: "✕" }

const Result = ({ result }: { readonly result: Result }) => (
  <>
    <Summary
      items={[
        ["Result", result.success ? "connected" : "failed"],
        ["Protocol", result.protocol === "implicit-tls" ? "implicit TLS" : "STARTTLS"],
        ["TLS", result.tlsUpgraded ? "yes" : "no"],
        ["Time", `${result.logs.at(-1)?.t ?? 0} ms`],
      ]}
    />
    <Checks result={result} />
    {result.greeting !== undefined
      ? (
        <>
          <h3>Banner</h3>
          <pre class="block">{result.greeting}</pre>
        </>
      )
      : null}
    {result.capabilities.length > 0
      ? (
        <>
          <h3>Capabilities{result.tlsUpgraded && result.protocol === "starttls" ? " after TLS" : ""}</h3>
          <Table head={["Capability", "Meaning"]} rows={result.capabilities.map((c) => [<code>{c}</code>, capabilityMeaning(c)])} />
        </>
      )
      : null}
    {result.plaintextCapabilities
      ? (
        <>
          <h3>Capabilities before TLS</h3>
          <p class="muted">{result.plaintextCapabilities.join(" · ")}</p>
        </>
      )
      : null}
    <h3>Transcript</h3>
    <Table
      head={["ms", "", "Line"]}
      rows={result.logs.map((l) => [
        l.t,
        <span class={l.direction === "error" ? "bad" : "muted"}>{ARROWS[l.direction]}</span>,
        l.direction === "info" ? <span class="muted">{l.message}</span> : <code>{l.message}</code>,
      ])}
    />
    <p class="muted">
      Runs over a raw TCP socket from the Worker. Workers cannot open port 25, so this tests submission, not relay.
    </p>
  </>
)

export const smtpSubmissionTest = Tool.make<Input, Result>({
  slug: "smtp-submission-test",
  title: "SMTP submission test",
  summary: "Connect to a mail server's submission port and check its banner, STARTTLS and login options.",
  category: "Email",
  params: Params,
  run: test,
  Form,
  Result,
  examples: [
    { label: "smtp.gmail.com:587", query: "host=smtp.gmail.com&port=587" },
    { label: "smtp.gmail.com:465", query: "host=smtp.gmail.com&port=465" },
    { label: "smtp.office365.com", query: "host=smtp.office365.com&port=587" },
  ],
})
