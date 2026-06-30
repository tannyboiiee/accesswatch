// POST /api/audit
// Cloudflare Pages Function — migrated from Vercel's api/audit.js.
//
// REAL FIX (Tier 1, per conversation): the original version asked Claude to
// invent "8 realistic accessibility violations" for a URL without ever
// looking at the page. This version actually fetches the page server-side
// and uses Cloudflare's native HTMLRewriter (a streaming HTML parser built
// into the Workers runtime — no extra dependency) to pull out real,
// concrete accessibility-relevant facts: missing alt text, unlabeled form
// inputs, heading order, missing lang attribute, empty/ambiguous link text.
// Claude is then asked to turn THOSE real facts into WCAG findings, not to
// invent plausible-sounding ones from the URL string alone.
//
// Known, disclosed limitation: this still can't assess things that require
// an actually-rendered page — computed color-contrast ratios, real focus
// order, visual overlap. Catching those needs a headless-browser product
// (Cloudflare has one — Browser Rendering / Puppeteer-on-Workers — but it's
// a meaningfully bigger build with its own cost/complexity tradeoffs;
// deliberately out of scope for this pass, see project notes / README).

const MAX_ITEMS_PER_CATEGORY = 25; // bounds prompt size on very large pages
const FETCH_TIMEOUT_MS = 8000;

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

  const { url, level } = body || {};
  if (!url) {
    return new Response(JSON.stringify({ error: { message: 'Missing url in request body' } }), { status: 400, headers });
  }

  // ---- 1. Fetch the real page, server-side ----
  let pageResponse;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    pageResponse = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'AccessWatchBot/1.0 (+accessibility audit)' },
    });
    clearTimeout(timeout);
  } catch (e) {
    return new Response(
      JSON.stringify({ error: { message: `Could not fetch ${url}: ${e.message}. The page may block automated requests, require JavaScript to render, or be unreachable.` } }),
      { status: 502, headers }
    );
  }

  if (!pageResponse.ok) {
    return new Response(
      JSON.stringify({ error: { message: `Fetching ${url} returned HTTP ${pageResponse.status}` } }),
      { status: 502, headers }
    );
  }

  // ---- 2. Extract real, concrete accessibility facts via HTMLRewriter ----
  const facts = {
    htmlLang: null,
    title: null,
    headings: [], // { level, text }
    imagesMissingAlt: [], // { src }
    imagesTotal: 0,
    inputsMissingLabel: [], // { type, name }
    inputsTotal: 0,
    emptyOrVagueLinks: [], // { href, text }
    linksTotal: 0,
  };

  let currentHeadingLevel = null;
  let currentHeadingText = '';
  let currentLinkHref = null;
  let currentLinkText = '';

  const rewriter = new HTMLRewriter()
    .on('html', {
      element(el) {
        facts.htmlLang = el.getAttribute('lang');
      },
    })
    .on('title', {
      text(t) {
        facts.title = (facts.title || '') + t.text;
      },
    })
    .on('h1, h2, h3, h4, h5, h6', {
      element(el) {
        currentHeadingLevel = el.tagName;
        currentHeadingText = '';
      },
      text(t) {
        currentHeadingText += t.text;
        if (t.lastInTextNode && currentHeadingLevel) {
          const text = currentHeadingText.trim();
          if (text) facts.headings.push({ level: currentHeadingLevel, text: text.slice(0, 80) });
          currentHeadingLevel = null;
        }
      },
    })
    .on('img', {
      element(el) {
        facts.imagesTotal++;
        const alt = el.getAttribute('alt');
        if (alt === null && facts.imagesMissingAlt.length < MAX_ITEMS_PER_CATEGORY) {
          facts.imagesMissingAlt.push({ src: (el.getAttribute('src') || '').slice(0, 120) });
        }
      },
    })
    .on('input, select, textarea', {
      element(el) {
        facts.inputsTotal++;
        const id = el.getAttribute('id');
        const ariaLabel = el.getAttribute('aria-label');
        const ariaLabelledby = el.getAttribute('aria-labelledby');
        const type = el.getAttribute('type') || el.tagName;
        // Note: we can't check for a matching <label for="id"> with
        // HTMLRewriter's streaming model without a second pass — flagged
        // here as "no aria-label and no id to associate a label with",
        // which is a real, if conservative, signal (an input with neither
        // can never be labeled at all).
        if (!ariaLabel && !ariaLabelledby && !id && facts.inputsMissingLabel.length < MAX_ITEMS_PER_CATEGORY) {
          facts.inputsMissingLabel.push({ type, name: el.getAttribute('name') || '(unnamed)' });
        }
      },
    })
    .on('a', {
      element(el) {
        facts.linksTotal++;
        currentLinkHref = el.getAttribute('href');
        currentLinkText = '';
        const ariaLabel = el.getAttribute('aria-label');
        if (ariaLabel) currentLinkText = ariaLabel; // pre-fill; element() runs before child text()
      },
      text(t) {
        currentLinkText += t.text;
        if (t.lastInTextNode) {
          const text = currentLinkText.trim().toLowerCase();
          const vague = ['', 'click here', 'here', 'read more', 'more', 'link'];
          if (vague.includes(text) && facts.emptyOrVagueLinks.length < MAX_ITEMS_PER_CATEGORY) {
            facts.emptyOrVagueLinks.push({ href: (currentLinkHref || '').slice(0, 120), text: currentLinkText.trim().slice(0, 40) || '(empty)' });
          }
        }
      },
    });

  try {
    const transformed = rewriter.transform(pageResponse);
    await transformed.text(); // drain the stream — handlers only fire as body is read
  } catch (e) {
    return new Response(JSON.stringify({ error: { message: `Failed to parse page HTML: ${e.message}` } }), { status: 502, headers });
  }

  // ---- 3. Check heading order for skipped levels (e.g. h1 -> h3, no h2) ----
  const headingIssues = [];
  let prevLevel = 0;
  for (const h of facts.headings) {
    const num = parseInt(h.level.slice(1), 10);
    if (prevLevel > 0 && num > prevLevel + 1) {
      headingIssues.push(`Heading order skips from <${'h' + prevLevel}> to <${h.level}> ("${h.text}")`);
    }
    prevLevel = num;
  }

  // ---- 4. Build a prompt grounded entirely in real, extracted facts ----
  const factsSummary = `
Page title: ${facts.title ? facts.title.trim() : '(missing — no <title> element found)'}
HTML lang attribute: ${facts.htmlLang || '(missing — no lang attribute on <html>)'}

Images: ${facts.imagesTotal} total, ${facts.imagesMissingAlt.length} missing an alt attribute entirely.
${facts.imagesMissingAlt.length ? facts.imagesMissingAlt.map((i) => `  - <img src="${i.src}"> has no alt attribute`).join('\n') : ''}

Form inputs: ${facts.inputsTotal} total, ${facts.inputsMissingLabel.length} have no id, aria-label, or aria-labelledby (so they cannot possibly be associated with a label).
${facts.inputsMissingLabel.length ? facts.inputsMissingLabel.map((i) => `  - <${i.type}> name="${i.name}"`).join('\n') : ''}

Links: ${facts.linksTotal} total, ${facts.emptyOrVagueLinks.length} have empty or non-descriptive text (e.g. "click here", "read more", or no text at all).
${facts.emptyOrVagueLinks.length ? facts.emptyOrVagueLinks.map((l) => `  - <a href="${l.href}">${l.text}</a>`).join('\n') : ''}

Heading structure (in document order): ${facts.headings.map((h) => h.level).join(' -> ') || '(no headings found)'}
${headingIssues.length ? headingIssues.map((i) => `  - ${i}`).join('\n') : '  No skipped heading levels detected.'}
`.trim();

  const hasAnyFindings =
    facts.imagesMissingAlt.length || facts.inputsMissingLabel.length || facts.emptyOrVagueLinks.length || headingIssues.length || !facts.htmlLang || !facts.title;

  const prompt = `You are AccessWatch, a WCAG 2.1 ${level || 'AA'} accessibility auditor.

Below are REAL, extracted facts about the actual HTML at ${url} — not a guess, not a hypothetical. Turn these into WCAG findings.

${factsSummary}

IMPORTANT — only report violations directly supported by the facts above. Do NOT invent issues about color contrast, focus order, keyboard navigation, or anything else that would require seeing the page rendered — that data was not collected and you have no basis for it. If the facts above show no real issues, return an empty array rather than inventing some. If a finding can be made, return it as a JSON array of objects, each with:
- criterion: WCAG code (e.g. "1.1.1")
- title: max 6 words
- impact: "critical", "serious", "moderate", or "minor"
- description: 1 short sentence, referencing the specific real element/fact above
- fix: 1 short sentence, concise actionable fix
- selector: the actual element from the facts above (e.g. the real src, name, or href shown)
- region: best guess at "header", "nav", "hero", "content", "sidebar", or "footer" based on the element's likely position (e.g. an <h1> is usually "hero", footer links are usually "footer") — this is the one field where a reasonable guess is fine, since position isn't in the extracted facts
- yPosition: integer 0-100, your best-guess approximate vertical position based on the region field above

Respond with ONLY the raw JSON array. No markdown fences, no preamble, no explanation before or after.`;

  if (!hasAnyFindings) {
    // No point spending a model call when there's structurally nothing to report —
    // return an honest empty result directly.
    return new Response(
      JSON.stringify({ issues: [], note: 'No structural accessibility issues detected in the extracted facts. Note: color contrast, focus order, and other rendering-dependent checks are not covered by this audit.' }),
      { status: 200, headers }
    );
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2048,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return new Response(JSON.stringify({ error: { message: err.error?.message || `Anthropic API error ${response.status}` } }), { status: response.status, headers });
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || '';
    const clean = text.replace(/```json|```/g, '').trim();
    const issues = JSON.parse(clean);

    return new Response(JSON.stringify({ issues }), { status: 200, headers });
  } catch (e) {
    return new Response(JSON.stringify({ error: { message: e.message } }), { status: 502, headers });
  }
}
