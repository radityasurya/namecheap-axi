import test from "node:test";
import assert from "node:assert/strict";
import { domainsCommand } from "../src/commands/domains.js";
import { split } from "../src/api.js";
import { fail, mockNamecheap, ok, withCredentials } from "./helpers.js";

test.beforeEach(withCredentials);

const INFO = ok(`<DomainGetInfoResult Status="Ok" DomainName="example.com">
  <DomainDetails>
    <CreatedDate>02/09/2022</CreatedDate>
    <ExpiredDate>02/09/2027</ExpiredDate>
  </DomainDetails>
  <Whoisguard Enabled="True"><ID>1</ID></Whoisguard>
  <DnsDetails ProviderType="CUSTOM">
    <Nameserver>a.ns.cloudflare.com</Nameserver>
    <Nameserver>b.ns.cloudflare.com</Nameserver>
  </DnsDetails>
</DomainGetInfoResult>`);

test("info reads the dates from child elements, not attributes", async () => {
  mockNamecheap({ "namecheap.domains.getInfo": INFO });
  const output = await domainsCommand(["info", "example.com"]);
  // CreatedDate/ExpiredDate are elements; reading them as attributes yields
  // empty strings and the dates silently vanish.
  assert.equal(output.created, "02/09/2022");
  assert.equal(output.expires, "02/09/2027");
  assert.equal(typeof output.days_left, "number");
  assert.equal(output.whois_guard, "enabled");
  assert.deepEqual(output.nameservers, ["a.ns.cloudflare.com", "b.ns.cloudflare.com"]);
});

test("a single domain still parses as a list", async () => {
  mockNamecheap({
    "namecheap.domains.getList": ok('<DomainGetListResult><Domain ID="1" Name="only.com" Expires="01/01/2030" IsExpired="false" IsLocked="false" AutoRenew="true" /></DomainGetListResult><Paging><TotalItems>1</TotalItems></Paging>'),
  });
  const output = await domainsCommand(["list"]);
  assert.equal(output.count, "1 of 1 total");
  assert.equal(output.domains[0].domain, "only.com");
});

for (const [command, argv] of [
  ["renew", ["renew", "example.com"]],
  ["reactivate", ["reactivate", "example.com"]],
  ["create", ["create", "example.com", "--contacts-from", "mine.com"]],
]) {
  test(`${command} refuses to spend money without --confirm`, async () => {
    const calls = mockNamecheap({});
    await assert.rejects(() => domainsCommand(argv), (error) => {
      assert.equal(error.code, "VALIDATION_ERROR");
      assert.match(error.suggestions.join(" "), /--confirm/);
      return true;
    });
    assert.equal(calls.length, 0, "no request may reach Namecheap without confirmation");
  });
}

test("lock is idempotent and reads before writing", async () => {
  const calls = mockNamecheap({
    "namecheap.domains.getRegistrarLock": ok('<DomainGetRegistrarLockResult Domain="example.com" RegistrarLockStatus="true" />'),
  });
  const output = await domainsCommand(["lock", "example.com"]);
  assert.equal(output.unchanged, true);
  assert.equal(calls.filter((c) => c.command === "namecheap.domains.setRegistrarLock").length, 0);
});

test("contacts redact emails and phones unless revealed", async () => {
  const contacts = ok(`<DomainContactsResult Domain="example.com">
    <Registrant><FirstName>Ada</FirstName><EmailAddress>ada@example.com</EmailAddress><Phone>+1.5555555</Phone></Registrant>
  </DomainContactsResult>`);
  mockNamecheap({ "namecheap.domains.getContacts": contacts });
  const hidden = await domainsCommand(["contacts", "example.com"]);
  assert.equal(hidden.registrant.FirstName, "Ada");
  assert.match(hidden.registrant.EmailAddress, /redacted/);
  assert.match(hidden.registrant.Phone, /redacted/);

  mockNamecheap({ "namecheap.domains.getContacts": contacts });
  const shown = await domainsCommand(["contacts", "example.com", "--reveal"]);
  assert.equal(shown.registrant.EmailAddress, "ada@example.com");
});

test("a non-whitelisted IP says so instead of blaming the key", async () => {
  mockNamecheap({
    "namecheap.domains.getList": fail("1011150", "Invalid request IP: 203.0.113.10"),
  });
  await assert.rejects(() => domainsCommand(["list"]), (error) => {
    assert.equal(error.code, "AUTH_ERROR");
    assert.match(error.suggestions.join(" "), /whitelist/i);
    return true;
  });
});

test("split rejects things that are not domains", () => {
  assert.deepEqual(split("https://example.com/path"), { SLD: "example", TLD: "com", domain: "example.com" });
  assert.deepEqual(split("sub.example.co.uk").TLD, "example.co.uk");
  for (const bad of ["example", "", ".com", "example."]) {
    assert.throws(() => split(bad), { code: "VALIDATION_ERROR" });
  }
});

test("credentials are required before any request", async () => {
  delete process.env.NAMECHEAP_API_KEY;
  const calls = mockNamecheap({});
  await assert.rejects(() => domainsCommand(["list"]), (error) => {
    assert.equal(error.code, "AUTH_REQUIRED");
    assert.match(error.message, /NAMECHEAP_API_KEY/);
    return true;
  });
  assert.equal(calls.length, 0);
});
