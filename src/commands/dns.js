import { AxiError } from "axi-sdk-js";
import { attrs, list, nc, split } from "../api.js";
import { BIN, helpFor, makeDispatcher, parse, positiveInt, required, wantsHelp } from "../args.js";

// Namecheap's own set, minus the ones that only make sense in its web UI.
const TYPES = ["A", "AAAA", "ALIAS", "CNAME", "MX", "MXE", "NS", "TXT", "URL", "URL301", "FRAME", "CAA"];
const DEFAULT_TTL = 1800;

const HELP = {
  list: helpFor({
    command: "dns list",
    description: "Every host record on a domain",
    usage: `${BIN} dns list <domain> [--type <type>]`,
    flags: { "--type": `Only this record type: ${TYPES.join(", ")}` },
    examples: [`${BIN} dns list example.com`, `${BIN} dns list example.com --type MX`],
  }),
  set: helpFor({
    command: "dns set",
    description: "Create or update one record, leaving every other record untouched",
    usage: `${BIN} dns set <domain> <host> <type> <address> [--ttl <n>] [--priority <n>]`,
    flags: {
      "--ttl": `Seconds, 60-60000 (default ${DEFAULT_TTL})`,
      "--priority": "MX preference, MX records only (default 10)",
    },
    examples: [
      `${BIN} dns set example.com www A 203.0.113.10`,
      `${BIN} dns set example.com @ MX mx.improvmx.com --priority 10`,
      `${BIN} dns set example.com _acme-challenge TXT "token-value"`,
    ],
  }),
  delete: helpFor({
    command: "dns delete",
    description: "Remove a record, leaving every other record untouched (already gone is a no-op)",
    usage: `${BIN} dns delete <domain> <host> [--type <type>]`,
    flags: { "--type": "Only delete this type at that host" },
    examples: [`${BIN} dns delete example.com old`, `${BIN} dns delete example.com www --type A`],
  }),
  nameservers: helpFor({
    command: "nameservers",
    description: "Which nameservers a domain uses",
    usage: `${BIN} nameservers <domain>`,
    examples: [`${BIN} nameservers example.com`],
  }),
  nsSet: helpFor({
    command: "nameservers set",
    description: "Point the domain at custom nameservers (idempotent)",
    usage: `${BIN} nameservers set <domain> <ns1> <ns2> [<ns3>...]`,
    examples: [`${BIN} nameservers set example.com ada.ns.cloudflare.com bob.ns.cloudflare.com`],
  }),
  nsDefault: helpFor({
    command: "nameservers default",
    description: "Hand DNS back to Namecheap's own nameservers (idempotent)",
    usage: `${BIN} nameservers default <domain>`,
    examples: [`${BIN} nameservers default example.com`],
  }),
};

const options = (values) => ({ sandbox: values.sandbox });

function recordRow(node) {
  const row = attrs(node);
  return {
    host: row.Name,
    type: row.Type,
    address: row.Address,
    ttl: Number(row.TTL ?? DEFAULT_TTL),
    ...(row.Type === "MX" ? { priority: Number(row.MXPref ?? 10) } : {}),
  };
}

/**
 * `namecheap.domains.dns.setHosts` REPLACES every record on the domain. Any
 * record missing from the call is deleted, silently and immediately. So every
 * write here reads the full set first, changes one entry, and sends all of them
 * back — the read is not an optimisation, it is what stops a one-record edit
 * from wiping the zone.
 */
async function readAll(domain, values) {
  const { SLD, TLD } = split(domain);
  const response = await nc("namecheap.domains.dns.getHosts", { SLD, TLD }, options(values));
  const result = response.DomainDNSGetHostsResult ?? {};
  return {
    records: list(result.host).map(recordRow),
    // Preserved verbatim: omitting it on setHosts resets email forwarding.
    emailType: attrs(result).EmailType,
    isOurDns: attrs(result).IsUsingOurDNS === "true",
  };
}

async function writeAll(domain, records, emailType, values) {
  const { SLD, TLD } = split(domain);
  const params = { SLD, TLD, ...(emailType ? { EmailType: emailType } : {}) };
  records.forEach((record, index) => {
    const n = index + 1;
    params[`HostName${n}`] = record.host;
    params[`RecordType${n}`] = record.type;
    params[`Address${n}`] = record.address;
    params[`TTL${n}`] = record.ttl;
    if (record.type === "MX") params[`MXPref${n}`] = record.priority ?? 10;
  });
  return nc("namecheap.domains.dns.setHosts", params, options(values));
}

async function dnsList(argv) {
  if (wantsHelp(argv)) return HELP.list;
  const { values, positionals } = parse(argv, { command: "dns list", flags: { type: { type: "string" } } });
  const domain = split(required(positionals[0], "<domain>", "dns list", `${BIN} dns list example.com`)).domain;
  const { records, isOurDns } = await readAll(domain, values);

  let shown = records;
  if (values.type) {
    const wanted = values.type.toUpperCase();
    shown = records.filter((record) => record.type === wanted);
  }
  if (shown.length === 0) {
    return {
      domain,
      records: values.type ? `0 ${values.type.toUpperCase()} records on ${domain}` : `0 records on ${domain}`,
      ...(isOurDns ? {} : { note: "this domain does not use Namecheap DNS, so there are no host records here" }),
    };
  }
  return {
    domain,
    ...(isOurDns ? {} : { warning: "domain is not using Namecheap DNS — these records are not authoritative" }),
    count: values.type ? `${shown.length} of ${records.length} total` : `${records.length} total`,
    records: shown,
    help: [`Run \`${BIN} dns set ${domain} <host> <type> <address>\` to add or change one`],
  };
}

function sameRecord(record, host, type) {
  return record.host === host && record.type === type;
}

async function set(argv) {
  if (wantsHelp(argv)) return HELP.set;
  const { values, positionals } = parse(argv, {
    command: "dns set",
    flags: { ttl: { type: "string" }, priority: { type: "string" } },
  });
  const domain = split(required(positionals[0], "<domain>", "dns set", `${BIN} dns set example.com www A 203.0.113.10`)).domain;
  const host = required(positionals[1], "<host>", "dns set", `${BIN} dns set ${domain} www A 203.0.113.10`);
  const type = required(positionals[2], "<type>", "dns set", `${BIN} dns set ${domain} ${host} A 203.0.113.10`).toUpperCase();
  const address = required(positionals[3], "<address>", "dns set", `${BIN} dns set ${domain} ${host} ${type} <value>`);
  if (!TYPES.includes(type)) {
    throw new AxiError(`unknown record type ${type}`, "VALIDATION_ERROR", [`valid types: ${TYPES.join(", ")}`]);
  }
  const ttl = positiveInt(values.ttl, "--ttl", DEFAULT_TTL);
  if (ttl < 60 || ttl > 60_000) {
    throw new AxiError(`--ttl ${ttl} is outside Namecheap's 60-60000 range`, "VALIDATION_ERROR", [
      `Example: ${BIN} dns set ${domain} ${host} ${type} ${address} --ttl 1800`,
    ]);
  }
  const priority = positiveInt(values.priority, "--priority", 10);

  const { records, emailType } = await readAll(domain, values);
  const matches = records.filter((record) => sameRecord(record, host, type));
  if (matches.length > 1) {
    throw new AxiError(`${matches.length} ${type} records already exist at ${host}`, "VALIDATION_ERROR", [
      "Refusing to guess which one to change",
      `Run \`${BIN} dns list ${domain} --type ${type}\` and delete the wrong one first`,
    ]);
  }

  const existing = matches[0];
  const desired = { host, type, address, ttl, ...(type === "MX" ? { priority } : {}) };
  if (existing && existing.address === address && existing.ttl === ttl && (type !== "MX" || existing.priority === priority)) {
    return { domain, record: desired, unchanged: true, note: "already set (no-op)" };
  }

  const next = existing
    ? records.map((record) => (sameRecord(record, host, type) ? desired : record))
    : [...records, desired];
  await writeAll(domain, next, emailType, values);

  return {
    domain,
    record: desired,
    ...(existing ? { updated: true, previous: existing.address } : { created: true }),
    total_records: next.length,
    help: [`Run \`${BIN} dns list ${domain}\` to confirm`],
  };
}

async function remove(argv) {
  if (wantsHelp(argv)) return HELP.delete;
  const { values, positionals } = parse(argv, { command: "dns delete", flags: { type: { type: "string" } } });
  const domain = split(required(positionals[0], "<domain>", "dns delete", `${BIN} dns delete example.com old`)).domain;
  const host = required(positionals[1], "<host>", "dns delete", `${BIN} dns delete ${domain} old`);
  const type = values.type?.toUpperCase();

  const { records, emailType } = await readAll(domain, values);
  const doomed = records.filter((record) => record.host === host && (!type || record.type === type));
  if (doomed.length === 0) {
    // AXI §6: already absent is the desired state.
    return { domain, host, deleted: false, unchanged: true, note: "no such record (no-op)" };
  }
  if (doomed.length > 1 && !type) {
    throw new AxiError(`${doomed.length} records exist at ${host}`, "VALIDATION_ERROR", [
      "Pass --type to choose which to delete",
      ...doomed.map((record) => `Run with --type ${record.type}  # ${record.address}`),
    ]);
  }

  const next = records.filter((record) => !doomed.includes(record));
  await writeAll(domain, next, emailType, values);
  return { domain, host, deleted: doomed.map((record) => ({ type: record.type, address: record.address })), total_records: next.length };
}

export const dnsCommand = makeDispatcher(
  "dns",
  { list: dnsList, set, delete: remove },
  {
    fallback: "list",
    summary: {
      list: "Every host record on a domain (default)",
      set: "Create or update one record, preserving the rest",
      delete: "Remove a record, preserving the rest",
    },
  },
);

async function nsShow(argv) {
  if (wantsHelp(argv)) return HELP.nameservers;
  const { values, positionals } = parse(argv, { command: "nameservers" });
  const domain = split(required(positionals[0], "<domain>", "nameservers", `${BIN} nameservers example.com`)).domain;
  const { SLD, TLD } = split(domain);
  const response = await nc("namecheap.domains.dns.getList", { SLD, TLD }, options(values));
  const result = response.DomainDNSGetListResult ?? {};
  const servers = list(result.Nameserver);

  return {
    domain,
    provider: attrs(result).IsUsingOurDNS === "true" ? "namecheap" : "custom",
    nameservers: servers,
    help: [
      attrs(result).IsUsingOurDNS === "true"
        ? `Run \`${BIN} dns list ${domain}\` for the records Namecheap serves`
        : `Run \`${BIN} nameservers default ${domain}\` to hand DNS back to Namecheap`,
    ],
  };
}

async function nsSet(argv) {
  if (wantsHelp(argv)) return HELP.nsSet;
  const { values, positionals } = parse(argv, { command: "nameservers set" });
  const domain = split(required(positionals[0], "<domain>", "nameservers set", `${BIN} nameservers set example.com ns1.example.net ns2.example.net`)).domain;
  const servers = positionals.slice(1).map((entry) => entry.toLowerCase());
  if (servers.length < 2) {
    throw new AxiError("at least two nameservers are required", "VALIDATION_ERROR", [
      `Example: ${BIN} nameservers set ${domain} ada.ns.cloudflare.com bob.ns.cloudflare.com`,
    ]);
  }

  const { SLD, TLD } = split(domain);
  const current = await nc("namecheap.domains.dns.getList", { SLD, TLD }, options(values));
  const existing = list(current.DomainDNSGetListResult?.Nameserver).map((entry) => String(entry).toLowerCase());
  if (existing.length === servers.length && existing.every((entry, index) => entry === servers[index])) {
    return { domain, nameservers: servers, unchanged: true, note: "already set (no-op)" };
  }

  await nc("namecheap.domains.dns.setCustom", { SLD, TLD, Nameservers: servers.join(",") }, options(values));
  return {
    domain,
    nameservers: servers,
    previous: existing,
    note: "nameserver changes take up to 48 hours to propagate",
  };
}

async function nsDefault(argv) {
  if (wantsHelp(argv)) return HELP.nsDefault;
  const { values, positionals } = parse(argv, { command: "nameservers default" });
  const domain = split(required(positionals[0], "<domain>", "nameservers default", `${BIN} nameservers default example.com`)).domain;
  const { SLD, TLD } = split(domain);

  const current = await nc("namecheap.domains.dns.getList", { SLD, TLD }, options(values));
  if (attrs(current.DomainDNSGetListResult).IsUsingOurDNS === "true") {
    return { domain, provider: "namecheap", unchanged: true, note: "already on Namecheap DNS (no-op)" };
  }
  await nc("namecheap.domains.dns.setDefault", { SLD, TLD }, options(values));
  return { domain, provider: "namecheap", note: "nameserver changes take up to 48 hours to propagate" };
}

export const nameserversCommand = makeDispatcher(
  "nameservers",
  { show: nsShow, set: nsSet, default: nsDefault },
  {
    fallback: "show",
    summary: {
      show: "Which nameservers a domain uses (default)",
      set: "Point at custom nameservers (idempotent)",
      default: "Hand DNS back to Namecheap (idempotent)",
    },
  },
);
