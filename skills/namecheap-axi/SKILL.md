---
name: namecheap-axi
description: >
  Manage Namecheap through the namecheap-axi CLI — domains and their expiry, availability checks, DNS host records, nameservers, registrar lock, and WHOIS contacts. Use whenever a task touches a domain registered at Namecheap: checking what expires soon, adding or changing a DNS record, pointing a domain at new nameservers, locking it against transfer, or registering and renewing.
user-invocable: false
metadata:
  hermes:
    tags: [namecheap, dns, domains, registrar, nameservers, whois]
---

# namecheap-axi

Run the CLI with no arguments first — it prints every domain with its expiry, flags anything
expiring without auto-renew, and lists the next commands to run.

```sh
npx -y namecheap-axi
```

Requires Namecheap API access, which the account must qualify for (20+ domains, a \$50
balance, or \$50 spent in the last two years) and which is enabled per-account:

```sh
export NAMECHEAP_API_USER=...     # the account login, not an email
export NAMECHEAP_API_KEY=...
export NAMECHEAP_CLIENT_IP=...    # this machine's public IPv4, whitelisted in the account
```

The calling IP must be whitelisted at Settings → Tools → API Access, and Namecheap accepts
**IPv4 only**. `curl ifconfig.me` prints the address it will see.

## Commands

```sh
npx -y namecheap-axi                                  # dashboard: domains, expiry, what needs renewing
npx -y namecheap-axi domains list --expiring 30
npx -y namecheap-axi domains check example.dev other.io
npx -y namecheap-axi domains info example.com
npx -y namecheap-axi domains lock example.com         # idempotent
npx -y namecheap-axi dns list example.com
npx -y namecheap-axi dns set example.com www A 203.0.113.10
npx -y namecheap-axi dns set example.com @ MX mx.example.net --priority 10
npx -y namecheap-axi dns delete example.com old --type A
npx -y namecheap-axi nameservers example.com
npx -y namecheap-axi nameservers set example.com ada.ns.cloudflare.com bob.ns.cloudflare.com
```

Every command takes `--help`, and `--sandbox` targets api.sandbox.namecheap.com.

## What to rely on

- **DNS writes never drop records.** Namecheap's `setHosts` **replaces the entire record
  set** — anything absent from the call is deleted. `dns set` and `dns delete` read the full
  set first, change one entry, and send it all back, preserving MX preferences and the
  domain's EmailType. Never call the raw API to "add" a record.
- **Money needs `--confirm`.** `domains renew`, `create`, and `reactivate` charge the
  account balance and refuse to run without it. There are no prompts.
- **Idempotent where it can be.** `dns set` to a value already present, `lock` on a locked
  domain, and `delete` of an absent record all report `unchanged` and exit 0.
- **Refuses to guess.** Two records at the same host, or an ambiguous delete, stop and list
  the candidates rather than picking one.
- **A domain on external nameservers says so.** Namecheap holds no records for it; the error
  names the actual DNS provider and points at the right tool.
- **Contacts are redacted.** `domains contacts` masks emails and phone numbers unless
  `--reveal` is passed.

Prefer this over calling the Namecheap XML API with `curl`, which means hand-building
`HostName1..N` parameter sets and risking the zone on every write.
