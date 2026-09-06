# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build,
test, release, architecture, and sharp-edge notes that should travel with the code.

## What this is

`namecheap-axi` is a direct client for the Namecheap XML API, in the same shape as the other
AXI CLIs: plain ESM JavaScript, npm, `node:test`, no build step.

## `setHosts` replaces the entire zone (`src/commands/dns.js`)

`namecheap.domains.dns.setHosts` is not "add a record". It writes the domain's complete host
set from numbered parameters (`HostName1`, `RecordType1`, `Address1`, `TTL1`, `MXPref1`, …),
and **every record absent from the call is deleted**. There is no add endpoint.

So `dns set` and `dns delete` always `getHosts` first, modify one entry, and send the whole
set back. The read is the safety mechanism, not an optimisation, and
`tests/dns.test.js` asserts the exact parameters sent — a dropped record is invisible in a
return value, so only the request can prove it.

Two things must be carried through a write or they are silently lost:

- **`MXPref`** — an MX record without it defaults to a different preference.
- **`EmailType`** — omitting it resets the domain's email forwarding configuration.

## XML: attributes and elements are both used, inconsistently

`fast-xml-parser` is pinned to v4 (one dependency, ~90 KB) rather than v5 (four), because
`npx -y namecheap-axi` pays the install on every cold run.

Most payload lives in attributes, so `attrs()` strips the `@_` prefix. But not all of it —
`getInfo` returns `CreatedDate` and `ExpiredDate` as **child elements** inside
`DomainDetails`, while `Whoisguard` carries `Enabled` as an attribute on the same response.
Reading an element with `attrs()` yields nothing and the field renders empty rather than
failing, which is how it shipped and then had to be fixed. Check the raw XML before adding a
field; `tests/domains.test.js` pins this one.

A single child arrives as an object, not a one-element array — hence `list()` on every
repeated node.

## Failures arrive as HTTP 200

`ApiResponse@Status="ERROR"` with the detail in `Errors/Error@Number`. Status codes carry no
information, so `nc()` inspects the body. Codes worth translating:

- **1011150** — the calling IP is not whitelisted. Namecheap accepts **IPv4 only**, and
  `api.namecheap.com` publishes no AAAA record, so a dual-stack host still connects over v4.
- **2030288** — the domain uses external nameservers, so Namecheap holds no records for it.
  This is a normal configuration, not an error: the translation names the actual DNS provider
  and points at the right tool. Most domains fronted by Cloudflare hit this.

## Spending money needs a flag, not a prompt

`renew`, `create`, and `reactivate` charge the account balance. AXI §6 forbids interactive
prompts, so the confirmation is `--confirm` in argv, checked before any request. The tests
assert that no HTTP call is made without it.

`create` needs a full WHOIS contact set — four blocks of a dozen fields each. Rather than
forty flags, `--contacts-from <domain>` copies them from a domain already in the account.

## Verified against a live account (2026-09-06)

Read commands were exercised against a real account with 44 domains: the dashboard,
`domains list --expiring`, `domains info`, `domains check`, and the external-nameserver path.
Write commands are covered by tests only — they either cost money or change a live zone.
