<h1 align="center">namecheap-axi</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/namecheap-axi"><img alt="npm" src="https://img.shields.io/npm/v/namecheap-axi?style=flat-square" /></a>
  <a href="https://axi.md"><img alt="AXI" src="https://img.shields.io/badge/built%20with-AXI-black?style=flat-square" /></a>
</p>

<h3 align="center">Namecheap CLI for agents.</h3>

Domains, DNS records, nameservers, and registrar lock from the shell, designed with
[AXI](https://axi.md) (Agent eXperience Interface).

## Why

Namecheap's API is XML-only, takes credentials as query parameters on every call, answers
`200` even when it fails, and — the part that matters —
**`namecheap.domains.dns.setHosts` replaces every record on the domain.**

That last one is not a footnote. The obvious way to add a DNS record with `curl` is one
`setHosts` call with the record you want. That call deletes everything else in the zone,
immediately and without warning. There is no "add record" endpoint.

`namecheap-axi dns set` reads the full record set, changes one entry, and writes all of them
back — carrying over MX preferences and the domain's `EmailType`, which resets email
forwarding if you drop it. The read is not an optimisation; it is the safety mechanism.

## Quick Start

```sh
npx skills add radityasurya/namecheap-axi --skill namecheap-axi -g
```

Then enable API access at
[ap.www.namecheap.com/settings/tools/apiaccess](https://ap.www.namecheap.com/settings/tools/apiaccess/).
The account must qualify: **20+ domains registered, a $50 balance, or $50 spent in the last
two years.**

```sh
export NAMECHEAP_API_USER=your-username    # the account login, not an email
export NAMECHEAP_API_KEY=...
export NAMECHEAP_CLIENT_IP=203.0.113.10    # this machine's public IPv4
```

`NAMECHEAP_CLIENT_IP` must be **whitelisted on that same page**, and Namecheap accepts
**IPv4 only** — a dual-stack host that prefers IPv6 will still work, because
`api.namecheap.com` publishes no AAAA record. `curl ifconfig.me` may print your v6 address;
use `curl -4 ifconfig.me`.

## Usage

```bash
namecheap-axi                                   # dashboard — domains, expiry, what needs renewing
namecheap-axi domains list --expiring 30
namecheap-axi domains check example.dev other.io
namecheap-axi domains info example.com
namecheap-axi domains contacts example.com      # redacted unless --reveal
namecheap-axi domains lock example.com          # idempotent
namecheap-axi domains renew example.com --years 1 --confirm

namecheap-axi dns list example.com
namecheap-axi dns list example.com --type MX
namecheap-axi dns set example.com www A 203.0.113.10
namecheap-axi dns set example.com @ MX mx.improvmx.com --priority 10
namecheap-axi dns set example.com _acme-challenge TXT "token"
namecheap-axi dns delete example.com old --type A

namecheap-axi nameservers example.com
namecheap-axi nameservers set example.com ada.ns.cloudflare.com bob.ns.cloudflare.com
namecheap-axi nameservers default example.com
namecheap-axi tlds --search dev
```

### Commands

| Command | Subcommands |
| --- | --- |
| *(none)* | Dashboard: domains sorted by expiry, with anything lapsing without auto-renew |
| `domains` | `list`, `check`, `info`, `contacts`, `lock`, `unlock`, `renew`, `reactivate`, `create` |
| `dns` | `list`, `set`, `delete` |
| `nameservers` | `show`, `set`, `default` |
| `tlds` | TLDs the account can register |
| `setup` | `hooks`, `status`, `uninstall` |

### Global flags

| Flag | Effect |
| --- | --- |
| `--sandbox` | Target `api.sandbox.namecheap.com` (or set `NAMECHEAP_SANDBOX=true`) |
| `--help` | Always allowed, never reported as unknown |

## Behaviour worth relying on

- **DNS writes preserve the zone.** Every write is read-modify-write. MX preference and
  `EmailType` are carried over.
- **Money needs `--confirm`.** `renew`, `create`, and `reactivate` charge the account and
  refuse without it. AXI forbids prompts, so the confirmation is a flag.
- **Idempotent.** Setting a record to its current value, locking a locked domain, or deleting
  an absent record all report `unchanged` and exit 0.
- **Refuses to guess.** Two records at one host, or an ambiguous delete, stop and list the
  candidates.
- **External nameservers are explained, not leaked.** Namecheap error 2030288 becomes "this
  domain does not use Namecheap DNS", with a pointer at whoever actually serves the zone.
- **Contacts redacted** unless `--reveal`.
- **TOON output** on stdout, structured errors on stdout too, diagnostics on stderr.

## Development

```sh
npm install
npm test              # node:test, no network — XML fixtures stand in for Namecheap
npm run build:skill
node bin/namecheap-axi.js --help
```

The suite asserts the exact parameters sent to `setHosts`, because "did it drop a record" is
not visible from a return value.

See [AGENTS.md](AGENTS.md) for architecture notes and [VISION.md](VISION.md) for scope.

## License

MIT
