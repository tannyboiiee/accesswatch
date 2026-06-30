# AccessWatch — deploy to Cloudflare Pages (free)

This replaces the Vercel deployment. Same idea — a tiny serverless backend
holds your Anthropic API key securely and talks to Claude on behalf of the
AccessWatch widget embedded in your Framer site. Visitors never see your
key — it lives only on Cloudflare's servers as an environment variable.

**Why the switch:** Vercel's free Hobby plan only allows one publicly
shareable/viewable deployment link, which doesn't work well alongside your
other portfolio projects. Cloudflare Pages doesn't have that restriction.

**What changed in this migration, beyond the platform:**
`api/audit.js` previously asked Claude to invent "8 realistic accessibility
violations" for a URL without ever looking at the actual page. It's been
rewritten to fetch the real page server-side and extract real, concrete
facts (missing `alt` text, unlabeled form inputs, heading order, missing
`lang` attribute, vague link text) using Cloudflare's built-in HTMLRewriter
— then Claude is asked to turn those *real* facts into WCAG findings, not
invent plausible-sounding ones. This still can't catch things that need an
actually-rendered page (color contrast, focus order) — that's a separate,
bigger upgrade (Cloudflare Browser Rendering) noted as a future option, not
built here.

## Steps (10–15 minutes, no coding required)

1. **Create a free Cloudflare account** at cloudflare.com if you don't
   already have one (you likely do, from Ballot Brief).

2. **Push these files to a GitHub repo** (a new one, or this same
   `my-portfolio` repo if you'd rather keep it together):
   - `functions/api/audit.js`
   - `functions/api/file-issues.js`
   - `public/index.html`
   - `package.json`

   Note the folder rename from Vercel's `api/` to Cloudflare's
   `functions/api/` — that's Cloudflare Pages' required convention for
   where serverless functions live; the route each one responds to
   (`/api/audit`, `/api/file-issues`) stays the same either way.

3. **Create the Pages project**:
   ```powershell
   npx wrangler pages deploy public --project-name=accesswatch
   ```
   First run will prompt you to log in (`wrangler login`) and create the
   project if it doesn't exist yet.

4. **Add your API key as an environment variable**:
   Cloudflare dashboard → Workers & Pages → accesswatch → Settings →
   Environment variables
   - Name: `ANTHROPIC_API_KEY`
   - Value: your key from console.anthropic.com/settings/keys
   - Mark it **Encrypted** (this is Cloudflare's equivalent of a Vercel
     "secret" env var — don't leave it as plaintext)
   - Save, then redeploy (or just push again — same as Ballot Brief, once
     GitHub auto-deploy is connected this happens automatically)

5. **Copy your deployment URL** — looks like
   `https://accesswatch.pages.dev` (or `https://accesswatch-xxx.pages.dev`
   for a specific deployment, same pattern as Ballot Brief)

6. **No code change needed in the Framer widget** — checked the actual
   frontend code already pushed here (`public/index.html`): both API calls
   use relative paths (`/api/audit`, `/api/file-issues`), not a hardcoded
   Vercel URL. As long as the widget embedded in Framer is pointed at this
   same Cloudflare Pages domain, it'll resolve correctly with zero changes.
   If your Framer code component currently has the old Vercel URL
   hardcoded anywhere, that's the one place to update — swap it for your
   new `accesswatch.pages.dev` domain.

## Cost

Cloudflare Pages' free tier comfortably covers a portfolio demo. Anthropic
API usage is billed separately and pay-as-you-go, same as before — a
portfolio demo with light traffic will cost very little, but worth keeping
an eye on usage at console.anthropic.com.

## Security note

Same as before: never put your API key directly in the Framer code
component or any client-side code — that exposes it to anyone who views
page source. The whole point of this backend is to keep the key
server-side only.

## What's NOT done here (documented, not silently skipped)

- **Real rendered-page analysis** (computed color contrast, real focus
  order, visual overlap) — would need Cloudflare's Browser Rendering
  product (a real headless-browser API, Puppeteer-compatible, runs inside
  Workers). It's a meaningfully bigger build — browser session management,
  ideally Durable Objects to reuse sessions instead of a cold-start cost
  every request — and has its own cost/quota considerations worth checking
  on Cloudflare's current pricing page before committing to it. Flagged as
  a deliberate next step, not built in this pass.
- **Sites that block automated fetches or require JavaScript to render**
  will fail the audit with a clear error message rather than silently
  falling back to inventing findings — this is intentional; an honest
  failure is better than a fabricated result.
