// POST /api/file-issues
// Cloudflare Pages Function — migrated from Vercel's api/file-issues.js.
// Logic is unchanged from the original; only the handler signature and
// request/response handling changed (Vercel's Node-style (req,res) →
// Cloudflare's Web-standard Request/Response, same shape Ballot Brief's
// functions already use).

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

export async function onRequestPost({ request }) {
  const headers = corsHeaders();

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: { message: 'Invalid JSON body' } }), { status: 400, headers });
  }

  const { repo, token, issues, sourceUrl } = body || {};

  if (!repo || !/^[^\/\s]+\/[^\/\s]+$/.test(repo)) {
    return new Response(JSON.stringify({ error: { message: 'repo must be in "owner/repo" format' } }), { status: 400, headers });
  }
  if (!token) {
    return new Response(JSON.stringify({ error: { message: 'Missing GitHub token' } }), { status: 400, headers });
  }
  if (!Array.isArray(issues) || !issues.length) {
    return new Response(JSON.stringify({ error: { message: 'No issues provided to file' } }), { status: 400, headers });
  }

  const results = [];

  for (const issue of issues) {
    const title = `a11y[${issue.impact}]: ${issue.title}`;
    const issueBody = [
      `**WCAG criterion:** ${issue.criterion}`,
      `**Impact:** ${issue.impact}`,
      `**Source:** ${sourceUrl || 'unknown'}`,
      '',
      `**Description**`,
      issue.description || '',
      '',
      `**Suggested fix**`,
      issue.fix || '',
      '',
      issue.selector ? `**Affected selector**\n\`${issue.selector}\`` : '',
      '',
      '---',
      '_Filed automatically by AccessWatch, an AI accessibility auditing agent._',
    ].join('\n');

    try {
      const ghRes = await fetch(`https://api.github.com/repos/${repo}/issues`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({
          title,
          body: issueBody,
          labels: [`a11y-${issue.impact}`],
        }),
      });

      if (!ghRes.ok) {
        const err = await ghRes.json().catch(() => ({}));
        results.push({ title, success: false, error: err.message || `HTTP ${ghRes.status}` });
        if (ghRes.status === 401 || ghRes.status === 403) {
          break;
        }
        continue;
      }

      const data = await ghRes.json();
      results.push({ title, success: true, url: data.html_url, number: data.number });
    } catch (e) {
      results.push({ title, success: false, error: e.message });
    }
  }

  const filed = results.filter((r) => r.success).length;
  return new Response(JSON.stringify({ results, filed, total: issues.length }), { status: 200, headers });
}
