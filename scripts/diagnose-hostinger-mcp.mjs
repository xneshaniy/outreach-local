const URL = "https://mcp.hostinger.com";
const TOKEN = process.env.HOSTINGER_MCP_TOKEN;

if (!TOKEN) {
  console.error("Set HOSTINGER_MCP_TOKEN.");
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${TOKEN}`,
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
  "MCP-Protocol-Version": "2025-06-18",
};

async function rpc(method, params, id = 1) {
  const res = await fetch(URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text };
}

(async () => {
  console.log("=== initialize ===");
  const init = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "opencode", version: "1.0" },
  });
  console.log(`  HTTP ${init.status}`);
  console.log(`  ${init.text.slice(0, 600)}`);

  const session = init.headers.get("mcp-session-id");
  console.log(`  session id: ${session ?? "(none)"}`);

  if (init.status >= 400) {
    console.log("\n=== the token was rejected ===");
    process.exit(1);
  }

  const withSession = { ...headers };
  if (session) withSession["mcp-session-id"] = session;

  console.log("\n=== tools/list ===");
  const tools = await fetch(URL, {
    method: "POST",
    headers: withSession,
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  });
  const toolsText = await tools.text();
  console.log(`  HTTP ${tools.status}`);
  try {
    // The response may be JSON or an SSE stream.
    const payload = toolsText.startsWith("event:") || toolsText.startsWith("data:")
      ? toolsText
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("")
      : toolsText;
    const parsed = JSON.parse(payload);
    const list = parsed.result?.tools ?? [];
    console.log(`  ${list.length} tool(s):`);
    for (const t of list) {
      console.log(`    - ${t.name}: ${String(t.description ?? "").split("\n")[0].slice(0, 110)}`);
    }
  } catch {
    console.log("  " + toolsText.slice(0, 900));
  }
})();
