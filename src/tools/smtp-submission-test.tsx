// SMTP submission test: a mail server's submission port over raw TCP. Reads
// the banner, sends EHLO, upgrades with STARTTLS when offered (implicit TLS on
// 465), sends EHLO again and returns the capabilities with the transcript.

import { connect } from "cloudflare:sockets"
import { Field, type Level, Select, Status, Summary, Table } from "../app/ui.tsx"
import * as Doh from "../lib/doh.ts"
import { isDomain } from "../lib/domain.ts"
import { optional, required } from "../lib/params.ts"
import { capabilitiesOf, isPrivateAddress } from "../lib/smtp-submission-test.ts"
import * as Tool from "./Tool.ts"

export const PORTS = [587, 465, 2525] as const
export type SubmissionPort = (typeof PORTS)[number]
/** Milliseconds for each step: DNS, connect, handshake, each reply. */
const TIMEOUT = 8000
const EHLO_NAME = "tools.mikepage.nl"

// --- Input ----------------------------------------------------------------------

export interface Input {
  readonly host: string
  readonly port: SubmissionPort
}

export const parse = (query: Tool.Query): Input => {
  const host = required(query, "host", "smtp.example.com").toLowerCase().replace(/\.$/, "")
  // IP literals are refused: a literal would skip the DNS check below.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) {
    throw new Tool.InputError("host: IP addresses are not accepted, enter a hostname")
  }
  if (!isDomain(host)) throw new Tool.InputError("host: expected a hostname such as smtp.example.com")
  // Port 25 is not on the list: Workers cannot open it.
  const raw = optional(query, "port") ?? "587"
  const port = PORTS.find((p) => String(p) === raw)
  if (port === undefined) throw new Tool.InputError("port: expected 587, 465 or 2525")
  return { host, port }
}

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

const addresses = async (host: string, type: "A" | "AAAA"): Promise<ReadonlyArray<string>> => {
  const { response } = await Doh.query(host, type, { timeout: TIMEOUT })
  return Doh.answersOf(response, type === "A" ? 1 : 28).map((a) => a.data)
}

export const assertPublicHost = async (host: string): Promise<void> => {
  const [a, aaaa] = await Promise.all([addresses(host, "A"), addresses(host, "AAAA")])
  const all = [...a, ...aaaa]
  if (all.length === 0) throw new Tool.InputError(`host: ${host} does not resolve to any address.`)
  if (all.some(isPrivateAddress)) throw new Tool.InputError(`host: ${host} resolves to a private or reserved address.`)
}

// --- The SMTP session -----------------------------------------------------------

/** Something went wrong on the connection; the probe reports it as its result. */
class SmtpError extends Error {
  override readonly name = "SmtpError"
}

type Log = (direction: LogEntry["direction"], message: string) => void

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Settles with `promise`, or fails with an SmtpError after TIMEOUT. */
const timed = async <A,>(promise: Promise<A>, what: string): Promise<A> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SmtpError(`${what} timed out after ${TIMEOUT / 1000} s`)), TIMEOUT)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

const awaitOpened = (socket: Socket, what: string) =>
  timed(socket.opened.catch((e: unknown) => Promise.reject(new SmtpError(`${what} failed: ${reason(e)}`))), what)

// A line-oriented SMTP session over one socket (one per TLS layer), logging
// every line both ways.
const session = (socket: Socket, log: Log) => {
  const reader = socket.readable.getReader()
  const writer = socket.writable.getWriter()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buf = ""

  // Reads reply lines until the final "NNN " line (a space, not a dash).
  const readLines = async (what: string): Promise<Array<string>> => {
    const lines: Array<string> = []
    while (true) {
      let i: number
      while ((i = buf.indexOf("\r\n")) !== -1) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 2)
        lines.push(line)
        log("received", line)
        if (/^\d{3}( |$)/.test(line)) return lines
      }
      let chunk: ReadableStreamReadResult<Uint8Array>
      try {
        chunk = await reader.read()
      } catch (e) {
        throw new SmtpError(`read failed: ${reason(e)}`)
      }
      if (chunk.done) throw new SmtpError(`connection closed while waiting for ${what}`)
      buf += decoder.decode(chunk.value, { stream: true })
    }
  }

  const read = (what: string) => timed(readLines(what), what)

  const send = async (line: string): Promise<void> => {
    log("sent", line)
    try {
      await timed(writer.write(encoder.encode(`${line}\r\n`)), `sending ${line.split(" ")[0]}`)
    } catch (e) {
      throw e instanceof SmtpError ? e : new SmtpError(`write failed: ${reason(e)}`)
    }
  }

  // Hands the socket back, before startTls() takes it over.
  const release = () => {
    reader.releaseLock()
    writer.releaseLock()
  }

  return { read, send, release }
}

const hasCapability = (caps: ReadonlyArray<string>, name: string) => caps.some((c) => c.toUpperCase().split(" ")[0] === name)

export const probe = async (host: string, port: number): Promise<Result> => {
  const started = Date.now()
  const logs: Array<LogEntry> = []
  const log: Log = (direction, message) => {
    logs.push({ t: Date.now() - started, direction, message })
  }
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

  // `socket` follows the STARTTLS upgrade, which replaces it; the finally
  // closes whichever is current, whatever happened.
  let socket: Socket | undefined
  try {
    log("info", `Connecting to ${host}:${port}${implicit ? " with implicit TLS" : ""}`)
    try {
      socket = connect({ hostname: host, port }, { secureTransport: implicit ? "on" : "starttls", allowHalfOpen: false })
    } catch (e) {
      throw new SmtpError(`connect failed: ${reason(e)}`)
    }
    await awaitOpened(socket, "TCP connect")
    log("info", implicit ? "Connected, TLS handshake done" : "Connected")
    let s = session(socket, log)

    result.greeting = (await s.read("greeting")).join("\n")
    await s.send(`EHLO ${EHLO_NAME}`)
    result.capabilities = capabilitiesOf(await s.read("EHLO reply"))

    if (!implicit && hasCapability(result.capabilities, "STARTTLS")) {
      await s.send("STARTTLS")
      const [reply = ""] = await s.read("STARTTLS reply")
      if (!reply.startsWith("220")) throw new SmtpError(`STARTTLS rejected: ${reply}`)
      log("info", "Upgrading to TLS")
      s.release()
      socket = socket.startTls({ expectedServerHostname: host })
      await awaitOpened(socket, "TLS handshake")
      log("info", "TLS handshake done")
      s = session(socket, log)
      result.tlsUpgraded = true
      result.plaintextCapabilities = result.capabilities
      // Servers often advertise different capabilities (typically AUTH) once TLS is up.
      await s.send(`EHLO ${EHLO_NAME}`)
      result.capabilities = capabilitiesOf(await s.read("EHLO reply after TLS"))
    }

    await s.send("QUIT")
    await s.read("QUIT reply").catch(() => undefined)
    result.success = true
  } catch (error) {
    // A failed probe is still a result: the transcript shows where it broke.
    if (!(error instanceof SmtpError)) throw error
    result.error = error.message
    log("error", error.message)
  } finally {
    await socket?.close().catch(() => undefined)
  }
  return result
}

export const test = async (input: Input): Promise<Result> => {
  await assertPublicHost(input.host)
  return probe(input.host, input.port)
}

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
  params: {
    host: { description: "Mail server hostname; IP addresses and hosts that resolve to private ranges are refused", required: true },
    port: { description: "Submission port: 587 and 2525 use STARTTLS, 465 implicit TLS", default: "587", values: PORTS.map(String) },
  },
  parse,
  run: test,
  Form,
  Result,
  examples: [
    { label: "smtp.gmail.com:587", query: "host=smtp.gmail.com&port=587" },
    { label: "smtp.gmail.com:465", query: "host=smtp.gmail.com&port=465" },
    { label: "smtp.office365.com", query: "host=smtp.office365.com&port=587" },
  ],
})
