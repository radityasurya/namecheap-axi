/** Namecheap answers XML for everything, including failures, always with 200. */
export function ok(inner) {
  return `<?xml version="1.0" encoding="utf-8"?>
<ApiResponse Status="OK" xmlns="http://api.namecheap.com/xml.response">
  <CommandResponse>${inner}</CommandResponse>
</ApiResponse>`;
}

export function fail(number, message) {
  return `<?xml version="1.0" encoding="utf-8"?>
<ApiResponse Status="ERROR" xmlns="http://api.namecheap.com/xml.response">
  <Errors><Error Number="${number}">${message}</Error></Errors>
</ApiResponse>`;
}

/**
 * Stand in for api.namecheap.com. `routes` maps a Command to XML (or a function
 * of the parsed query). Returns the call log so a test can assert exactly which
 * parameters were sent — which is the only way to catch a setHosts that drops
 * records.
 */
export function mockNamecheap(routes) {
  const calls = [];
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    const query = Object.fromEntries(parsed.searchParams);
    calls.push({ command: query.Command, query, host: parsed.host });
    const route = routes[query.Command];
    const body =
      typeof route === "function" ? route(query) : (route ?? fail("1", `no route for ${query.Command}`));
    return { ok: true, status: 200, text: async () => body };
  };
  return calls;
}

export function withCredentials() {
  process.env.NAMECHEAP_API_USER = "tester";
  process.env.NAMECHEAP_API_KEY = "key";
  process.env.NAMECHEAP_CLIENT_IP = "203.0.113.10";
  delete process.env.NAMECHEAP_SANDBOX;
  delete process.env.NAMECHEAP_USERNAME;
}

export const HOSTS = ok(`<DomainDNSGetHostsResult Domain="example.com" IsUsingOurDNS="true" EmailType="MX">
  <host HostId="1" Name="@" Type="A" Address="203.0.113.1" TTL="1800" />
  <host HostId="2" Name="www" Type="CNAME" Address="example.com." TTL="1800" />
  <host HostId="3" Name="@" Type="MX" Address="mx.example.net" MXPref="10" TTL="1800" />
  <host HostId="4" Name="_acme-challenge" Type="TXT" Address="token" TTL="60" />
</DomainDNSGetHostsResult>`);
