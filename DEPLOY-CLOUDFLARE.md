# AccessWatch — deploy to Cloudflare Pages (free)

This replaces the Vercel deployment. Same idea — a tiny serverless backend
holds your Anthropic API key securely and talks to Claude on behalf of the
AccessWatch widget embedded in your Framer site. Visitors never see your
key — it lives only on Cloudflare's servers as an environment variable.

**Why the switch:** Vercel's free Hobby plan only allows one publicly
shareable/viewable deployment link, which doesn't work well alongside your
other portfolio projects. Cloudflare Pages doesn't have that restriction.

**Important: this package now ports the REAL, working version** —
`github.com/tannyboiiee/my-portfolio`, branch `multi-page-crawl` — the one
Vercel was actually deployed from, confirmed by checking the Vercel
project's Git settings directly. An earlier pass had migrated an older/
incomplete copy of this backend that never had the multi-page crawl
feature; that version has been discarded in favor of this faithful port of
the real one. Nothing about the audit logic itself was changed beyond the
platform-required handler signature (Vercel's `(req,res)` → Cloudflare's
`(request,env)`).

**What the real version actually does, for reference:** it fetches each
submitted page's real HTML server-side (truncated to 8,000 characters) and
gives that to Claude as grounding context — falling back to URL-only
analysis only if the fetch genuinely fails. It accepts up to 4
`additionalUrls` for true multi-page crawling (normalized, deduplicated,
restricted to the same hostname as the base URL), audits all pages in
parallel, and isolates per-page failures so one broken page doesn't take
down the whole batch.

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

6. **No code change needed in the Framer widget** — both API calls in
   `public/index.html` use relative paths (`/api/audit`, `/api/file-issues`),
   not a hardcoded Vercel URL. As long as the widget embedded in Framer is
   pointed at this same Cloudflare Pages domain, it'll resolve correctly
   with zero changes. If your Framer code component currently has the old
   Vercel URL hardcoded anywhere, that's the one place to update — swap it
   for your new `accesswatch.pages.dev` domain.

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

## Known, disclosed limitation (inherited from the real version, not new)

Because each page's HTML is truncated to 8,000 characters before being
sent to Claude, very long pages will only be analyzed based on their first
8,000 characters of markup — content further down the page (or content
injected later by client-side JavaScript) won't be seen. This is the same
limitation the real, working Vercel version already had; this port doesn't
change that behavior. If you ever want to lift it, the options are
sending more of the page (more tokens, more cost per audit) or moving to
a structured-extraction approach that doesn't depend on truncation —
worth a separate conversation if it becomes a real problem in practice.

