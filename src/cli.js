import { runAxiCli } from "axi-sdk-js";
// The SDK renders command output itself but does not re-export its encoder,
// so the static top-level help encodes through the same official TOON library.
import { encode } from "@toon-format/toon";
import { CREDENTIAL_HELP, attrs, baseUrl, hasCredentials, list, nc } from "./api.js";
import { BIN } from "./args.js";
import { dnsCommand, nameserversCommand } from "./commands/dns.js";
import { domainsCommand, tldsCommand } from "./commands/domains.js";
import { setupCommand } from "./commands/setup.js";
import { VERSION } from "./version.js";

export const DESCRIPTION = "Manage Namecheap domains, DNS records, and nameservers";

const HOME_ROWS = 10;
const EXPIRING_SOON = 60;

export const TOP_HELP = `${encode({
  usage: `${BIN} [command] [args] [flags]`,
  commands: {
    "(none)": "dashboard — domains, expiry, and anything expiring soon",
    domains: "list, check, info, contacts, lock, unlock, renew, reactivate, create",
    dns: "list, set, delete",
    nameservers: "show, set, default",
    tlds: "TLDs this account can register",
    setup: "hooks, status, uninstall",
  },
  globals: { "--sandbox": "Use api.sandbox.namecheap.com instead of production" },
  auth: "NAMECHEAP_API_USER + NAMECHEAP_API_KEY + NAMECHEAP_CLIENT_IP (whitelisted)",
  warning: "`dns set` and `dns delete` rewrite the whole record set; they read it first so nothing else is lost",
  examples: [
    BIN,
    `${BIN} dns list example.com`,
    `${BIN} dns set example.com www A 203.0.113.10`,
    `${BIN} domains check example.dev`,
    `${BIN} domains list --expiring 30`,
  ],
  help: [`Run \`${BIN} <command> --help\` for a command reference`],
})}\n`;

/** Days until a `MM/DD/YYYY` expiry, which is how Namecheap formats dates. */
function daysUntil(expires) {
  const [month, day, year] = String(expires).split("/").map(Number);
  if (!year) return undefined;
  return Math.round((Date.UTC(year, month - 1, day) - Date.now()) / 86_400_000);
}

/**
 * AXI §8: no-args shows live state. Missing credentials are reported as data
 * with a fix, not as a failure — this view is what a SessionStart hook runs.
 */
async function home() {
  const api = baseUrl();
  if (!hasCredentials()) {
    return { api, domains: "no Namecheap API credentials in the environment", help: CREDENTIAL_HELP };
  }

  const response = await nc("namecheap.domains.getList", { PageSize: 100 }, {});
  const domains = list(response.DomainGetListResult?.Domain).map((node) => {
    const row = attrs(node);
    return {
      domain: row.Name,
      expires: String(row.Expires ?? ""),
      days_left: daysUntil(row.Expires),
      auto_renew: row.AutoRenew === "true",
      locked: row.IsLocked === "true",
    };
  });

  if (domains.length === 0) {
    return {
      api,
      domains: "0 domains in this account",
      help: [`Run \`${BIN} domains check <name>\` to find one to register`],
    };
  }

  const soon = domains
    .filter((entry) => entry.days_left !== undefined && entry.days_left <= EXPIRING_SOON && !entry.auto_renew)
    .sort((a, b) => a.days_left - b.days_left);
  const total = response.Paging?.TotalItems ?? domains.length;

  return {
    api,
    count: `${domains.length} of ${total} total`,
    ...(soon.length
      ? { expiring: soon.map((entry) => `${entry.domain} in ${entry.days_left} days (auto-renew off)`) }
      : {}),
    domains: domains
      .slice()
      .sort((a, b) => (a.days_left ?? 0) - (b.days_left ?? 0))
      .slice(0, HOME_ROWS)
      .map((entry) => ({ domain: entry.domain, days_left: entry.days_left, auto_renew: entry.auto_renew })),
    help: [
      `Run \`${BIN} dns list <domain>\` for its DNS records`,
      `Run \`${BIN} domains list --expiring 30\` for what needs renewing`,
      ...(domains.length > HOME_ROWS ? [`Run \`${BIN} domains list\` for all ${total}`] : []),
    ],
  };
}

export async function main() {
  await runAxiCli({
    description: DESCRIPTION,
    version: VERSION,
    topLevelHelp: TOP_HELP,
    home,
    commands: {
      domains: domainsCommand,
      dns: dnsCommand,
      nameservers: nameserversCommand,
      tlds: tldsCommand,
      setup: setupCommand,
    },
  });
}
