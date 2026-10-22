/**
 * Try harder to reach Hostinger's API.
 *
 * The MCP server wants OAuth, and api.hostinger.com answered 530 (a
 * Cloudflare origin error) rather than 401. This checks whether that was
 * transient, whether a different host or path works, and whether the token
 * is a management token at all.
 */
const TOKEN = process.env.HOSTINGER_MCP_TOKEN;

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
  Origin: "https://hpanel.hostinger.com",
  Referer: "https://hpanel.hostinger.com/",
};

const HOSTS = [
  "https://api.hostinger.com",
  "https://api.hostinger.com/v2",
  "https://api.hostinger.com/hosting",
];

const PATHS = [
  "/v2/accounts",
  "/v2/accounts/subscriptions",
  "/v2/hosting/websites",
  "/v2/hosting/domains",
  "/hosting/v1/hosting",
  "/hosting/v1/domains",
  "/oauth/authorize",
  "/",
];

(async () => {
  console.log("=== is api.hostinger.com reachable at all? ===");
  for (const base of HOSTS) {
    const res = await fetch(base, { headers: { ...BROWSER_HEADERS } }).catch((e) => ({ status: 0, text: e.message }));
    const text = await res.text?.().catch(() => "");
    console.log(`  ${base.padEnd(38)} -> ${res.status}  ${String(text).slice(0, 90).replace(/\n/g, " ")}`);
  }

  console.log("\n=== with the token, on the documented paths ===");
  for (const base of HOSTS) {
    for (const p of PATHS) {
      const url = `${base}${p}`.replace(/([^:])\/\//g, "$1/");
      for (const [header, value] of [
        ["X-API-Key", TOKEN],
        ["Authorization", `Bearer ${TOKEN}`],
      ]) {
        const res = await fetch(url, {
          headers: { ...BROWSER_HEADERS, [header]: value },
          redirect: "manual",
        }).catch((e) => ({ status: 0, text: e.message }));
        const text = await res.text?.().catch(() => "");
        const interesting = res.status !== 404 && res.status !== 530;
        if (interesting) {
          console.log(`  ${String(header).padEnd(14)} ${url.padEnd(52)} -> ${res.status}  ${String(text).slice(0, 120).replace(/\n/g, " ")}`);
        }
      }
    }
  }
  console.log("\n  (only responses other than 404/530 are shown)");
})();
