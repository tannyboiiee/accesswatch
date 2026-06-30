// POST /api/audit
// Cloudflare Pages Function — faithful port of the REAL, working
// multi-page-crawl branch (github.com/tannyboiiee/my-portfolio, branch
// "multi-page-crawl") that was actually deployed and working on Vercel.
//
// This is NOT the earlier from-scratch rewrite — that was built against an
// older/incomplete version of the backend that never had the crawl feature.
// This port preserves the real, proven logic exactly:
//   - fetches each page's real HTML server-side (truncated to 8000 chars),
//     falling back to URL-only analysis ONLY if the fetch genuinely fails
//   - accepts up to 4 additionalUrls for true multi-page crawling,
//     normalized/deduped/restricted to the same hostname as the base url
//   - audits all pages in parallel, isolates per-page failures so one
//     broken page doesn't kill the whole batch
//   - scales issues-per-page down as page count goes up, so a 5-page crawl
//     doesn't return 40 issues
//
// Only the platform-required parts changed: Vercel's (req,res) handler →
// Cloudflare's (request,env) Web-standard signature, process.env → env,
// res.status().json() → new Response(JSON.stringify(...), {status}).

async function fetchPageHtml(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AccessWatchBot/1.0)' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    return text.substring(0, 8000);
  } catch {
    return null;
  }
}

async function auditPage(apiKey, pageUrl, level, pageHtml, issueCount) {
  const siteContext = pageHtml
    ? `Here is the actual HTML source of the page (first 8000 chars):\n\`\`\`html\n${pageHtml}\n\`\`\``
    : `The page could not be fetched directly. Analyse based on the URL and common accessibility patterns for this type of page.`;

  const prompt = `You are AccessWatch, an expert WCAG accessibility auditor. Analyse ${pageUrl} for WCAG 2.1 ${level || 'AA'} violations.

${siteContext}

Return a JSON array of exactly ${issueCount} realistic accessibility violations for this specific page. Each item must have:
- criterion: WCAG code (e.g. "1.4.3")
- title: max 6 words
- impact: "critical", "serious", "moderate", or "minor"
- description: 1 short sentence
- fix: 1 short sentence, concise actionable fix
- selector: affected CSS selector or element
- region: one of "header", "nav", "hero", "content", "sidebar", "footer"
- yPosition: integer 0-100, approximate vertical position on the page

Keep every field brief. Distribute yPosition realistically (header/nav low like 2-15, hero 15-30, content 30-70, footer 85-98). Respond with ONLY the raw JSON array. No markdown fences, no preamble, no explanation.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1536,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || `Anthropic API error ${response.status}`);
  }

  const data = await response.json();
  const text = data.content?.[0]?.text || '';
  const clean = text.replace(/```json|```/g, '').trim();
  const issues = JSON.parse(clean);

  return issues.map((issue) => ({ ...issue, pageUrl }));
}

function normalizeUrls(rawUrls, baseUrl) {
  const base = new URL(baseUrl);
  const seen = new Set();
  const result = [];
  for (const raw of rawUrls) {
    if (!raw || typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    try {
      const resolved = new URL(trimmed, base);
      if (resolved.hostname !== base.hostname) continue;
      resolved.hash = '';
      const normalized = resolved.toString().replace(/\/$/, '');
      if (!seen.has(normalized)) {
        seen.add(normalized);
        result.push(normalized);
      }
    } catch {
      continue;
    }
  }
  return result;
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export async function onRequestPost({ request, env }) {
  const headers = corsHeaders();

  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: { message: 'Server misconfigured: ANTHROPIC_API_KEY not set' } }), { status: 500, headers });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: { message: 'Invalid JSON body' } }), { status: 400, headers });
  }

  const { url, level, additionalUrls } = body || {};
  if (!url) {
    return new Response(JSON.stringify({ error: { message: 'Missing url in request body' } }), { status: 400, headers });
  }

  let extraPages = [];
  if (Array.isArray(additionalUrls) && additionalUrls.length) {
    extraPages = normalizeUrls(additionalUrls, url).slice(0, 4);
  }

  const totalPages = 1 + extraPages.length;
  const issuesPerPage = totalPages === 1 ? 8 : Math.max(3, Math.round(8 / totalPages) + 2);

  try {
    const allUrls = [url, ...extraPages];
    const fetched = await Promise.all(allUrls.map(async (u) => ({ url: u, html: await fetchPageHtml(u) })));

    const pageResults = await Promise.all(
      fetched.map((page) => auditPage(apiKey, page.url, level, page.html, issuesPerPage).catch((e) => ({ error: e.message, pageUrl: page.url })))
    );

    const issues = [];
    const pagesAudited = [];
    const pageErrors = [];

    for (let i = 0; i < pageResults.length; i++) {
      const result = pageResults[i];
      if (Array.isArray(result)) {
        issues.push(...result);
        pagesAudited.push(fetched[i].url);
      } else {
        pageErrors.push({ url: fetched[i].url, error: result.error });
      }
    }

    if (!issues.length) {
      return new Response(
        JSON.stringify({ error: { message: 'Failed to audit any pages: ' + (pageErrors[0]?.error || 'unknown error') } }),
        { status: 502, headers }
      );
    }

    return new Response(JSON.stringify({ issues, pagesAudited, pageErrors }), { status: 200, headers });
  } catch (e) {
    return new Response(JSON.stringify({ error: { message: e.message } }), { status: 502, headers });
  }
}
