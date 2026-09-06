import test from "node:test";
import assert from "node:assert/strict";
import { dnsCommand } from "../src/commands/dns.js";
import { HOSTS, fail, mockNamecheap, ok, withCredentials } from "./helpers.js";

test.beforeEach(withCredentials);

const SET_OK = ok('<DomainDNSSetHostsResult Domain="example.com" IsSuccess="true" />');

/** Rebuild the record set a setHosts call actually sent. */
function sentRecords(query) {
  const records = [];
  for (let n = 1; query[`HostName${n}`] !== undefined; n += 1) {
    records.push({
      host: query[`HostName${n}`],
      type: query[`RecordType${n}`],
      address: query[`Address${n}`],
      ttl: Number(query[`TTL${n}`]),
    });
  }
  return records;
}

test("adding a record resends every existing record", async () => {
  const calls = mockNamecheap({
    "namecheap.domains.dns.getHosts": HOSTS,
    "namecheap.domains.dns.setHosts": SET_OK,
  });
  const output = await dnsCommand(["set", "example.com", "blog", "A", "203.0.113.9"]);

  const write = calls.find((call) => call.command === "namecheap.domains.dns.setHosts");
  const sent = sentRecords(write.query);
  // setHosts REPLACES the zone. Anything missing here is deleted, silently.
  assert.equal(sent.length, 5, "4 existing records plus the new one");
  for (const host of ["@", "www", "_acme-challenge", "blog"]) {
    assert.ok(sent.some((r) => r.host === host), `${host} must survive the write`);
  }
  assert.equal(output.created, true);
  assert.equal(output.total_records, 5);
});

test("the MX preference and EmailType survive a write", async () => {
  const calls = mockNamecheap({
    "namecheap.domains.dns.getHosts": HOSTS,
    "namecheap.domains.dns.setHosts": SET_OK,
  });
  await dnsCommand(["set", "example.com", "blog", "A", "203.0.113.9"]);
  const write = calls.find((call) => call.command === "namecheap.domains.dns.setHosts").query;

  // Dropping EmailType resets the domain's email forwarding configuration.
  assert.equal(write.EmailType, "MX");
  const mxIndex = [1, 2, 3, 4, 5].find((n) => write[`RecordType${n}`] === "MX");
  assert.equal(write[`MXPref${mxIndex}`], "10", "MX preference must be carried over");
});

test("setting a record to its current value writes nothing", async () => {
  const calls = mockNamecheap({
    "namecheap.domains.dns.getHosts": HOSTS,
    "namecheap.domains.dns.setHosts": SET_OK,
  });
  const output = await dnsCommand(["set", "example.com", "@", "A", "203.0.113.1"]);
  assert.equal(output.unchanged, true);
  assert.equal(calls.filter((call) => call.command === "namecheap.domains.dns.setHosts").length, 0);
});

test("updating replaces only the matching record", async () => {
  const calls = mockNamecheap({
    "namecheap.domains.dns.getHosts": HOSTS,
    "namecheap.domains.dns.setHosts": SET_OK,
  });
  const output = await dnsCommand(["set", "example.com", "@", "A", "203.0.113.99"]);
  const sent = sentRecords(calls.find((c) => c.command === "namecheap.domains.dns.setHosts").query);

  assert.equal(output.updated, true);
  assert.equal(output.previous, "203.0.113.1");
  assert.equal(sent.length, 4, "an update must not change the record count");
  assert.equal(sent.find((r) => r.host === "@" && r.type === "A").address, "203.0.113.99");
  assert.ok(sent.some((r) => r.host === "@" && r.type === "MX"), "the MX at the same host must survive");
});

test("deleting something already absent is a no-op", async () => {
  const calls = mockNamecheap({ "namecheap.domains.dns.getHosts": HOSTS });
  const output = await dnsCommand(["delete", "example.com", "nothing-here"]);
  assert.equal(output.unchanged, true);
  assert.equal(calls.filter((call) => call.command === "namecheap.domains.dns.setHosts").length, 0);
});

test("deleting an ambiguous host refuses and lists the types", async () => {
  const calls = mockNamecheap({ "namecheap.domains.dns.getHosts": HOSTS });
  await assert.rejects(() => dnsCommand(["delete", "example.com", "@"]), (error) => {
    assert.equal(error.code, "VALIDATION_ERROR");
    assert.match(error.suggestions.join(" "), /--type A/);
    assert.match(error.suggestions.join(" "), /--type MX/);
    return true;
  });
  assert.equal(calls.filter((call) => call.command === "namecheap.domains.dns.setHosts").length, 0);
});

test("an out-of-range TTL is rejected before any request", async () => {
  const calls = mockNamecheap({});
  await assert.rejects(() => dnsCommand(["set", "example.com", "www", "A", "1.2.3.4", "--ttl", "30"]), (error) => {
    assert.equal(error.code, "VALIDATION_ERROR");
    return true;
  });
  assert.equal(calls.length, 0);
});

test("a domain on external nameservers explains itself instead of leaking the code", async () => {
  mockNamecheap({
    "namecheap.domains.dns.getHosts": fail("2030288", "Cannot complete this command as this domain is not using proper DNS servers"),
  });
  await assert.rejects(() => dnsCommand(["list", "example.com"]), (error) => {
    assert.equal(error.code, "VALIDATION_ERROR");
    assert.match(error.suggestions.join(" "), /cloudflare-axi/);
    assert.ok(!error.message.includes("2030288"));
    return true;
  });
});
