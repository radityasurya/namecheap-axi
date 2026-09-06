import { AxiError } from "axi-sdk-js";
import { attrs, list, nc, requireConfirm, split } from "../api.js";
import { BIN, helpFor, makeDispatcher, parse, positiveInt, required, wantsHelp } from "../args.js";

const PAGE_SIZE = 100;

const HELP = {
  list: helpFor({
    command: "domains list",
    description: "Domains in the account, with expiry and lock state",
    usage: `${BIN} domains list [--expiring <days>] [--limit <n>]`,
    flags: {
      "--expiring": "Only domains expiring within this many days",
      "--limit": `Rows to fetch, max 100 per page (default ${PAGE_SIZE})`,
    },
    examples: [`${BIN} domains list`, `${BIN} domains list --expiring 60`],
  }),
  check: helpFor({
    command: "domains check",
    description: "Whether names are available, and what they cost",
    usage: `${BIN} domains check <domain> [<domain>...]`,
    examples: [`${BIN} domains check example.com`, `${BIN} domains check a.com b.dev c.io`],
  }),
  info: helpFor({
    command: "domains info",
    description: "One domain's registration, expiry, nameservers, and WHOIS guard",
    usage: `${BIN} domains info <domain>`,
    examples: [`${BIN} domains info example.com`],
  }),
  contacts: helpFor({
    command: "domains contacts",
    description: "Registrant, tech, admin and billing contacts (emails redacted unless --reveal)",
    usage: `${BIN} domains contacts <domain> [--reveal]`,
    flags: { "--reveal": "Print contact emails and phone numbers in clear text" },
    examples: [`${BIN} domains contacts example.com`],
  }),
  lock: helpFor({
    command: "domains lock|unlock",
    description: "Registrar lock, which blocks transfers away (idempotent)",
    usage: `${BIN} domains lock|unlock <domain>`,
    examples: [`${BIN} domains lock example.com`, `${BIN} domains unlock example.com`],
  }),
  renew: helpFor({
    command: "domains renew",
    description: "Extend a registration. CHARGES the account balance",
    usage: `${BIN} domains renew <domain> --years <n> --confirm`,
    flags: { "--years": "Years to add (default 1)", "--confirm": "Required — this spends money" },
    examples: [`${BIN} domains renew example.com --years 1 --confirm`],
  }),
  create: helpFor({
    command: "domains create",
    description: "Register a domain. CHARGES the account balance",
    usage: `${BIN} domains create <domain> --years <n> --contacts-from <domain> --confirm`,
    flags: {
      "--years": "Years to register (default 1)",
      "--contacts-from": "Copy WHOIS contacts from a domain already in the account",
      "--confirm": "Required — this spends money",
    },
    examples: [`${BIN} domains create example.com --contacts-from mine.com --confirm`],
  }),
  reactivate: helpFor({
    command: "domains reactivate",
    description: "Restore an expired domain. CHARGES the account balance",
    usage: `${BIN} domains reactivate <domain> --confirm`,
    examples: [`${BIN} domains reactivate example.com --confirm`],
  }),
  tlds: helpFor({
    command: "tlds",
    description: "TLDs this account can register, and whether they support the API",
    usage: `${BIN} tlds [--search <text>]`,
    flags: { "--search": "Only TLDs containing this text" },
    examples: [`${BIN} tlds`, `${BIN} tlds --search dev`],
  }),
};

const options = (values) => ({ sandbox: values.sandbox });

function domainRow(node) {
  const row = attrs(node);
  return {
    domain: row.Name,
    expires: String(row.Expires ?? ""),
    auto_renew: row.AutoRenew === "true",
    locked: row.IsLocked === "true",
    ...(row.IsExpired === "true" ? { expired: true } : {}),
  };
}

/** Days until a `MM/DD/YYYY` expiry, which is how Namecheap formats dates. */
function daysUntil(expires) {
  const [month, day, year] = String(expires).split("/").map(Number);
  if (!year) return undefined;
  return Math.round((Date.UTC(year, month - 1, day) - Date.now()) / 86_400_000);
}

async function domainsList(argv) {
  if (wantsHelp(argv)) return HELP.list;
  const { values } = parse(argv, {
    command: "domains list",
    flags: { expiring: { type: "string" }, limit: { type: "string" } },
  });
  const pageSize = positiveInt(values.limit, "--limit", PAGE_SIZE);
  const response = await nc(
    "namecheap.domains.getList",
    { PageSize: Math.min(pageSize, PAGE_SIZE) },
    options(values),
  );
  let domains = list(response.DomainGetListResult?.Domain).map(domainRow);
  const total = response.Paging?.TotalItems ?? domains.length;

  if (values.expiring !== undefined) {
    const within = positiveInt(values.expiring, "--expiring", 30);
    domains = domains.filter((entry) => {
      const days = daysUntil(entry.expires);
      return days !== undefined && days <= within;
    });
    if (domains.length === 0) {
      return { domains: `0 domains expiring within ${within} days`, checked: `${total} total` };
    }
  }
  if (domains.length === 0) {
    return { domains: "0 domains in this account", help: [`Run \`${BIN} domains check <name>\` to find one`] };
  }

  return {
    count: `${domains.length} of ${total} total`,
    domains: domains.map((entry) => ({
      ...entry,
      ...(daysUntil(entry.expires) !== undefined ? { days_left: daysUntil(entry.expires) } : {}),
    })),
    help: [
      `Run \`${BIN} dns list <domain>\` for its DNS records`,
      `Run \`${BIN} domains info <domain>\` for registration detail`,
    ],
  };
}

async function check(argv) {
  if (wantsHelp(argv)) return HELP.check;
  const { values, positionals } = parse(argv, { command: "domains check" });
  if (positionals.length === 0) {
    throw new AxiError("<domain> is required", "VALIDATION_ERROR", [`${BIN} domains check example.com`]);
  }
  const names = positionals.map((name) => split(name).domain);
  const response = await nc("namecheap.domains.check", { DomainList: names.join(",") }, options(values));
  const results = list(response.DomainCheckResult).map((node) => {
    const row = attrs(node);
    return {
      domain: row.Domain,
      available: row.Available === "true",
      ...(row.IsPremiumName === "true"
        ? { premium: true, price: row.PremiumRegistrationPrice }
        : {}),
    };
  });

  const free = results.filter((entry) => entry.available);
  return {
    count: `${free.length} of ${results.length} available`,
    results,
    ...(free.length
      ? { help: [`Run \`${BIN} domains create ${free[0].domain} --contacts-from <domain> --confirm\` to register`] }
      : {}),
  };
}

async function info(argv) {
  if (wantsHelp(argv)) return HELP.info;
  const { values, positionals } = parse(argv, { command: "domains info" });
  const domain = split(required(positionals[0], "<domain>", "domains info", `${BIN} domains info example.com`)).domain;
  const response = await nc("namecheap.domains.getInfo", { DomainName: domain }, options(values));
  const result = response.DomainGetInfoResult ?? {};
  const row = attrs(result);
  const dns = attrs(result.DnsDetails);

  // CreatedDate and ExpiredDate are child elements, not attributes — reading
  // them with attrs() silently yields nothing and the dates render empty.
  const details = result.DomainDetails ?? {};
  const expires = details.ExpiredDate;

  return {
    domain: row.DomainName,
    status: row.Status,
    created: String(details.CreatedDate ?? ""),
    expires: String(expires ?? ""),
    ...(daysUntil(expires) !== undefined ? { days_left: daysUntil(expires) } : {}),
    whois_guard: attrs(result.Whoisguard).Enabled === "True" ? "enabled" : "disabled",
    dns_provider: dns.ProviderType ?? "-",
    nameservers: list(result.DnsDetails?.Nameserver),
    help: [`Run \`${BIN} dns list ${row.DomainName}\` for its records`],
  };
}

const SECRET = /email|phone|fax/i;

async function contacts(argv) {
  if (wantsHelp(argv)) return HELP.contacts;
  const { values, positionals } = parse(argv, {
    command: "domains contacts",
    flags: { reveal: { type: "boolean" } },
  });
  const domain = split(required(positionals[0], "<domain>", "domains contacts", `${BIN} domains contacts example.com`)).domain;
  const response = await nc("namecheap.domains.getContacts", { DomainName: domain }, options(values));
  const result = response.DomainContactsResult ?? {};

  const shape = (node) => {
    if (!node) return undefined;
    const entries = Object.entries(node)
      .filter(([key]) => !key.startsWith("@_"))
      .map(([key, value]) => [
        key,
        !values.reveal && SECRET.test(key) && value ? "<redacted — pass --reveal>" : value,
      ]);
    return Object.fromEntries(entries);
  };

  return {
    domain,
    registrant: shape(result.Registrant),
    tech: shape(result.Tech),
    admin: shape(result.Admin),
    billing: shape(result.AuxBilling),
    ...(values.reveal ? {} : { note: "emails and phones redacted; pass --reveal to print them" }),
  };
}

/** lock and unlock are the same command with a flag, and re-running is a no-op. */
function locker(desired) {
  return async function change(argv) {
    if (wantsHelp(argv)) return HELP.lock;
    const { values, positionals } = parse(argv, { command: desired ? "domains lock" : "domains unlock" });
    const domain = split(
      required(positionals[0], "<domain>", "domains lock", `${BIN} domains lock example.com`),
    ).domain;

    const current = await nc("namecheap.domains.getRegistrarLock", { DomainName: domain }, options(values));
    const locked = attrs(current.DomainGetRegistrarLockResult).RegistrarLockStatus === "true";
    if (locked === desired) {
      return { domain, locked, unchanged: true, note: `already ${desired ? "locked" : "unlocked"} (no-op)` };
    }

    await nc(
      "namecheap.domains.setRegistrarLock",
      { DomainName: domain, LockAction: desired ? "LOCK" : "UNLOCK" },
      options(values),
    );
    return { domain, locked: desired, previous: locked };
  };
}

async function renew(argv) {
  if (wantsHelp(argv)) return HELP.renew;
  const { values, positionals } = parse(argv, {
    command: "domains renew",
    flags: { years: { type: "string" }, confirm: { type: "boolean" } },
  });
  const domain = split(required(positionals[0], "<domain>", "domains renew", `${BIN} domains renew example.com --confirm`)).domain;
  const years = positiveInt(values.years, "--years", 1);
  requireConfirm(values, `renewing ${domain} for ${years} year(s)`, `${BIN} domains renew ${domain} --years ${years} --confirm`);

  const response = await nc("namecheap.domains.renew", { DomainName: domain, Years: years }, options(values));
  const row = attrs(response.DomainRenewResult);
  return {
    domain,
    renewed: true,
    years,
    ...(row.ChargedAmount ? { charged: row.ChargedAmount } : {}),
    ...(row.DomainDetails ? {} : {}),
    help: [`Run \`${BIN} domains info ${domain}\` to confirm the new expiry`],
  };
}

async function reactivate(argv) {
  if (wantsHelp(argv)) return HELP.reactivate;
  const { values, positionals } = parse(argv, {
    command: "domains reactivate",
    flags: { confirm: { type: "boolean" } },
  });
  const domain = split(required(positionals[0], "<domain>", "domains reactivate", `${BIN} domains reactivate example.com --confirm`)).domain;
  requireConfirm(values, `reactivating ${domain}`, `${BIN} domains reactivate ${domain} --confirm`);

  const response = await nc("namecheap.domains.reactivate", { DomainName: domain }, options(values));
  const row = attrs(response.DomainReactivateResult);
  return { domain, reactivated: true, ...(row.ChargedAmount ? { charged: row.ChargedAmount } : {}) };
}

/**
 * Registration needs a full WHOIS contact set — four blocks of a dozen fields.
 * Copying them from a domain already in the account is the only way to do this
 * from a command line without forty flags.
 */
async function create(argv) {
  if (wantsHelp(argv)) return HELP.create;
  const { values, positionals } = parse(argv, {
    command: "domains create",
    flags: { years: { type: "string" }, "contacts-from": { type: "string" }, confirm: { type: "boolean" } },
  });
  const domain = split(required(positionals[0], "<domain>", "domains create", `${BIN} domains create example.com --contacts-from mine.com --confirm`)).domain;
  const source = required(
    values["contacts-from"],
    "--contacts-from",
    "domains create",
    `${BIN} domains create ${domain} --contacts-from <a domain you already own> --confirm`,
  );
  const years = positiveInt(values.years, "--years", 1);
  requireConfirm(values, `registering ${domain} for ${years} year(s)`, `${BIN} domains create ${domain} --contacts-from ${source} --years ${years} --confirm`);

  const from = await nc("namecheap.domains.getContacts", { DomainName: split(source).domain }, options(values));
  const result = from.DomainContactsResult ?? {};
  const blocks = { Registrant: result.Registrant, Tech: result.Tech, Admin: result.Admin, AuxBilling: result.AuxBilling };
  const params = { DomainName: domain, Years: years };
  for (const [role, node] of Object.entries(blocks)) {
    if (!node) {
      throw new AxiError(`${source} has no ${role} contact to copy`, "VALIDATION_ERROR", [
        `Run \`${BIN} domains contacts ${source} --reveal\` to see what is set`,
      ]);
    }
    for (const [field, value] of Object.entries(node)) {
      if (!field.startsWith("@_") && value !== "" && value !== undefined) params[`${role}${field}`] = value;
    }
  }

  const response = await nc("namecheap.domains.create", params, options(values));
  const row = attrs(response.DomainCreateResult);
  return {
    domain,
    registered: row.Registered === "true",
    years,
    ...(row.ChargedAmount ? { charged: row.ChargedAmount } : {}),
    contacts_from: source,
    help: [`Run \`${BIN} dns list ${domain}\` once the registration settles`],
  };
}

export async function tldsCommand(argv) {
  if (wantsHelp(argv)) return HELP.tlds;
  const { values } = parse(argv, { command: "tlds", flags: { search: { type: "string" } } });
  const response = await nc("namecheap.domains.getTldList", {}, options(values));
  let tlds = list(response.Tlds?.Tld).map((node) => {
    const row = attrs(node);
    return { tld: row.Name, type: row.Type, api_registerable: row.IsApiRegisterable === "true" };
  });
  if (values.search) {
    const wanted = values.search.toLowerCase();
    tlds = tlds.filter((entry) => String(entry.tld).toLowerCase().includes(wanted));
  }
  if (tlds.length === 0) {
    return { tlds: `0 TLDs matching ${values.search ?? ""}`.trim() };
  }
  return { count: `${tlds.length} total`, tlds };
}

export const domainsCommand = makeDispatcher(
  "domains",
  {
    list: domainsList,
    check,
    info,
    contacts,
    lock: locker(true),
    unlock: locker(false),
    renew,
    reactivate,
    create,
  },
  {
    fallback: "list",
    summary: {
      list: "Domains with expiry and lock state (default)",
      check: "Whether names are available",
      info: "One domain's registration detail",
      contacts: "WHOIS contacts (redacted)",
      lock: "Lock against transfer (idempotent)",
      unlock: "Unlock for transfer (idempotent)",
      renew: "Extend registration — charges the account",
      reactivate: "Restore an expired domain — charges the account",
      create: "Register a domain — charges the account",
    },
  },
);
