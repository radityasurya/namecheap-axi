# Vision

## The problem

Namecheap's API predates the conventions people now expect. It is XML-only, authenticates
with four query parameters on every call, returns HTTP 200 for failures with the real status
in an attribute, and splits domains into `SLD` and `TLD` on half its commands.

None of that is fatal. One thing nearly is: **`setHosts` replaces the entire DNS record set.**
There is no endpoint that adds a record. An agent that reads the docs quickly, sees
`HostName1/RecordType1/Address1`, and sends one record has just deleted the zone.

## What namecheap-axi is

One agent-ergonomic surface over that API, following the ten [AXI](https://axi.md)
principles.

It owns four things raw API calls do not:

1. **Read-modify-write on every DNS change.** The full record set is fetched, one entry is
   changed, and everything goes back — including MX preferences and `EmailType`, which resets
   email forwarding when omitted.
2. **A confirmation token for spending.** `renew`, `create`, and `reactivate` charge the
   account balance. They require `--confirm` in argv, because AXI forbids prompts and a
   registration should not be one typo away.
3. **Errors that name the cause.** A non-whitelisted IP, a disabled API, and a domain on
   external nameservers are three different problems that Namecheap reports in similar ways.
4. **Refusal to guess.** Two A records at one host is a question, not a coin flip.

## What it deliberately does not do

- **No transfers.** Moving a domain between registrars is consequential, slow, and involves
  auth codes and a receiving registrar. It belongs at the dashboard.
- **No bulk destructive operations.** No "delete all records", no multi-domain writes.
- **No credential minting.** The API key comes from the environment. This tool never logs in
  or writes a credential to disk.
- **No interactive anything.** Every operation completes from flags alone.

## Where it could go

- **`dns import` / `export`** in zone-file form, which would make a registrar migration a
  two-command operation rather than a spreadsheet.
- **Expiry as ambient context**, so a session hook surfaces a domain lapsing this week
  before anyone asks.
- **`domains transfer`**, if the auth-code flow can be made safe from a CLI.
