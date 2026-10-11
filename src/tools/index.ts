// Every tool. The overview groups them by category, sorted by title.

import { browserinfo } from "./browserinfo.tsx"
import { cloudflareEdge } from "./cloudflare-edge.tsx"
import { dmarcValidator } from "./dmarc-validator.tsx"
import { dnsDiscovery } from "./dns-discovery.tsx"
import { dnsLookup } from "./dns-lookup.tsx"
import { externalLinkScanner } from "./external-link-scanner.tsx"
import { ipInfo } from "./ip-info.tsx"
import { ipv6Utils } from "./ipv6-utils.tsx"
import { rdapLookup } from "./rdap-lookup.tsx"
import { smtpSubmissionTest } from "./smtp-submission-test.tsx"
import { spfValidator } from "./spf-validator.tsx"
import type { AnyTool } from "./Tool.ts"

export const tools: ReadonlyArray<AnyTool> = [
  browserinfo,
  cloudflareEdge,
  dmarcValidator,
  dnsDiscovery,
  dnsLookup,
  externalLinkScanner,
  ipInfo,
  ipv6Utils,
  rdapLookup,
  smtpSubmissionTest,
  spfValidator,
].sort((a, b) => a.title.localeCompare(b.title))
