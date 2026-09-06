import { XMLParser } from "fast-xml-parser";
import { AxiError } from "axi-sdk-js";
import { BIN } from "./args.js";

const PRODUCTION = "https://api.namecheap.com/xml.response";
const SANDBOX = "https://api.sandbox.namecheap.com/xml.response";

// Namecheap answers XML for every command; there is no JSON API. Attributes
// carry most of the payload, so `@_` prefixed keys are the norm, not the
// exception.
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

export const CREDENTIAL_HELP = [
  "Enable API access at https://ap.www.namecheap.com/settings/tools/apiaccess/",
  "It requires 20+ domains registered, a $50 balance, or $50 spent in the last 2 years",
  "Export NAMECHEAP_API_USER, NAMECHEAP_API_KEY and NAMECHEAP_CLIENT_IP",
  "NAMECHEAP_CLIENT_IP must be whitelisted on that same page — `curl ifconfig.me` prints yours",
];

export function hasCredentials(env = process.env) {
  return Boolean(env.NAMECHEAP_API_USER && env.NAMECHEAP_API_KEY && env.NAMECHEAP_CLIENT_IP);
}

export function baseUrl(env = process.env, sandbox = false) {
  return sandbox || env.NAMECHEAP_SANDBOX === "true" ? SANDBOX : PRODUCTION;
}

function credentials(env = process.env) {
  if (!hasCredentials(env)) {
    const missing = ["NAMECHEAP_API_USER", "NAMECHEAP_API_KEY", "NAMECHEAP_CLIENT_IP"].filter(
      (name) => !env[name],
    );
    throw new AxiError(`Missing ${missing.join(", ")}`, "AUTH_REQUIRED", CREDENTIAL_HELP);
  }
  return {
    ApiUser: env.NAMECHEAP_API_USER,
    ApiKey: env.NAMECHEAP_API_KEY,
    // UserName is the account the command acts on; it equals ApiUser unless a
    // reseller is acting for someone else.
    UserName: env.NAMECHEAP_USERNAME || env.NAMECHEAP_API_USER,
    ClientIp: env.NAMECHEAP_CLIENT_IP,
  };
}

/** Namecheap reports failures inside a 200 response, not by status code. */
function apiError(errors, command) {
  const list = [].concat(errors ?? []);
  const first = list[0] ?? {};
  const number = String(first["@_Number"] ?? "");
  const message = String(first["#text"] ?? first ?? "Namecheap rejected the request");

  if (number === "1011102" || /API Key is invalid|API access/i.test(message)) {
    return new AxiError(message, "AUTH_ERROR", [
      "The API key is wrong, or API access is not enabled for this account",
      ...CREDENTIAL_HELP.slice(0, 2),
    ]);
  }
  if (number === "1011150" || /IP/i.test(message)) {
    return new AxiError(message, "AUTH_ERROR", [
      "The calling IP is not whitelisted for this API key",
      "Whitelist it at https://ap.www.namecheap.com/settings/tools/apiaccess/",
      "`curl ifconfig.me` prints the address Namecheap sees",
    ]);
  }
  // 2030288: the domain points at custom nameservers, so Namecheap holds no
  // host records for it. That is a normal configuration, not a failure, and the
  // fix is to ask whoever actually serves the zone.
  if (number === "2030288" || /not using proper DNS servers/i.test(message)) {
    return new AxiError("this domain does not use Namecheap DNS", "VALIDATION_ERROR", [
      "Its nameservers point somewhere else, so Namecheap has no host records for it",
      `Run \`${BIN} nameservers <domain>\` to see where DNS is served`,
      "If that is Cloudflare, manage the records with `cloudflare-axi dns`",
      `Run \`${BIN} nameservers default <domain>\` to move DNS back to Namecheap`,
    ]);
  }
  if (/not (found|associated)|does not exist/i.test(message)) {
    return new AxiError(message, "NOT_FOUND", [`Run \`${BIN} domains list\` to see the account's domains`]);
  }
  if (/insufficient|balance|funds/i.test(message)) {
    return new AxiError(message, "API_ERROR", [
      "The account balance does not cover this operation",
      "Top up at https://ap.www.namecheap.com/profile/billing/funds",
    ]);
  }
  return new AxiError(message, "API_ERROR", [
    `while running \`${command}\``,
    ...(number ? [`Namecheap error ${number}`] : []),
  ]);
}

/**
 * One command against the XML API. Namecheap takes everything as query
 * parameters, including writes, and answers 200 even for failures — the status
 * lives in an attribute.
 */
export async function nc(command, params = {}, options = {}) {
  const { env = process.env, sandbox = false, fetchImpl = fetch } = options;
  const url = new URL(baseUrl(env, sandbox));
  for (const [key, value] of Object.entries({ ...credentials(env), Command: command, ...params })) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }

  let response;
  try {
    response = await fetchImpl(url.toString(), { headers: { accept: "application/xml" } });
  } catch (cause) {
    throw new AxiError(`Could not reach the Namecheap API: ${cause.message}`, "NETWORK_ERROR", [
      "Check network connectivity to api.namecheap.com",
    ]);
  }

  const text = await response.text();
  let parsed;
  try {
    parsed = parser.parse(text);
  } catch {
    throw new AxiError("Namecheap returned a response that is not XML", "API_ERROR", [
      `while running \`${command}\``,
      "Check NAMECHEAP_SANDBOX and that the API endpoint is reachable",
    ]);
  }

  const root = parsed?.ApiResponse;
  if (!root) {
    throw new AxiError("Namecheap returned an unrecognised response", "API_ERROR", [
      `while running \`${command}\``,
    ]);
  }
  if (root["@_Status"] === "ERROR") throw apiError(root.Errors?.Error, command);
  return root.CommandResponse ?? {};
}

/** Attribute-heavy XML means single children arrive as objects, not arrays. */
export function list(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** `@_Name` -> `name`, so commands read as data rather than as XML. */
export function attrs(node = {}) {
  return Object.fromEntries(
    Object.entries(node)
      .filter(([key]) => key.startsWith("@_"))
      .map(([key, value]) => [key.slice(2), value]),
  );
}

/** Namecheap splits a domain into SLD and TLD on most DNS commands. */
export function split(domain) {
  const clean = String(domain).trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const dot = clean.indexOf(".");
  if (dot < 1 || dot === clean.length - 1) {
    throw new AxiError(`\`${domain}\` is not a domain name`, "VALIDATION_ERROR", [
      `Example: ${BIN} dns list example.com`,
    ]);
  }
  return { SLD: clean.slice(0, dot), TLD: clean.slice(dot + 1), domain: clean };
}

/**
 * Spending money or changing WHOIS from a CLI needs a deliberate token in argv.
 * AXI forbids interactive prompts, so the confirmation is a flag.
 */
export function requireConfirm(values, action, example) {
  if (!values.confirm) {
    throw new AxiError(`${action} needs --confirm`, "VALIDATION_ERROR", [
      "This charges the account balance or changes registration data",
      `Re-run with --confirm: ${example}`,
    ]);
  }
}
