/**
 * Static link validation.
 *
 * This NEVER makes a network request. Fetching a recipient's links would
 * leak the fact that the email was opened, would be slow, and would make the
 * pre-flight check depend on the internet. The checks below are purely
 * syntactic, which is what a pre-flight can honestly guarantee.
 *
 * The optional network check is available for an operator who explicitly
 * wants it (see `checkLinksOverNetwork`), and it is never run automatically.
 */

export type LinkProblem = {
  url: string;
  problem: "INVALID_URL" | "NOT_HTTP" | "UNSAFE_SCHEME" | "PLACEHOLDER" | "UNBALANCED_MARKUP";
  detail: string;
};

const PLACEHOLDER_URLS = new Set([
  "http://example.com",
  "https://example.com",
  "http://localhost",
  "https://localhost",
  "#",
  "",
]);

function extractLinks(html: string): string[] {
  const links: string[] = [];
  const re = /href\s*=\s*("([^"]*)"|'([^']*)')/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    links.push((m[2] ?? m[3] ?? "").trim());
  }
  return links;
}

/**
 * Validate the links of an HTML body.
 * Returns the problems found; an empty array means nothing is obviously wrong.
 */
export function validateLinks(html: string): LinkProblem[] {
  const problems: LinkProblem[] = [];

  for (const url of extractLinks(html)) {
    if (PLACEHOLDER_URLS.has(url.toLowerCase())) {
      problems.push({
        url,
        problem: url === "" ? "INVALID_URL" : "PLACEHOLDER",
        detail:
          url === ""
            ? "An empty href was found."
            : "This is a placeholder link - replace it before sending.",
      });
      continue;
    }
    if (url.startsWith("{{")) {
      problems.push({ url, problem: "PLACEHOLDER", detail: "The link still contains a template placeholder." });
      continue;
    }
    if (/^(mailto|tel|sms):/i.test(url)) continue; // not a web link
    if (url.startsWith("#")) continue; // in-page anchor
    if (!/^https?:\/\//i.test(url)) {
      problems.push({
        url,
        problem: "NOT_HTTP",
        detail: "Only http(s) links are tracked; a relative link will break in an email client.",
      });
      continue;
    }
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        problems.push({ url, problem: "UNSAFE_SCHEME", detail: `Unsupported scheme ${parsed.protocol}` });
      }
    } catch {
      problems.push({ url, problem: "INVALID_URL", detail: "This is not a valid URL." });
    }
  }

  // A body that was edited by hand can end up with unbalanced tags.
  const openTags = (html.match(/<a\b[^>]*>/gi) ?? []).length;
  const closeTags = (html.match(/<\/a>/gi) ?? []).length;
  if (openTags !== closeTags) {
    problems.push({
      url: "",
      problem: "UNBALANCED_MARKUP",
      detail: `The body has ${openTags} opening and ${closeTags} closing link tags.`,
    });
  }

  return problems;
}

/**
 * Optionally verify that links resolve. NEVER called automatically.
 * It is opt-in because it contacts third-party servers.
 */
export async function checkLinksOverNetwork(
  urls: string[],
  options: { timeoutMs?: number; concurrency?: number } = {},
): Promise<Array<{ url: string; ok: boolean; status?: number; error?: string }>> {
  const timeoutMs = options.timeoutMs ?? 8000;
  const limit = Math.max(1, Math.min(10, options.concurrency ?? 5));
  const out: Array<{ url: string; ok: boolean; status?: number; error?: string }> = [];

  const queue = urls.filter((u) => /^https?:\/\//i.test(u));
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length > 0) {
      const url = queue.shift();
      if (!url) return;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, { method: "HEAD", redirect: "manual", signal: controller.signal });
        out.push({ url, ok: res.status < 400, status: res.status });
      } catch (err) {
        out.push({ url, ok: false, error: (err as Error).message });
      } finally {
        clearTimeout(timer);
      }
    }
  });
  await Promise.all(workers);
  return out;
}
