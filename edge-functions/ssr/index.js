/*~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
 ~ AEM Edge Function — Server-Side Rendering for React SPA
 ~
 ~ Runtime:   Adobe Managed CDN (Fastly Compute JavaScript) — BETA
 ~ Deploy:    Cloud Manager pipeline (requires AEM Edge Functions beta access)
 ~ Docs:      https://experienceleague.adobe.com/en/docs/experience-manager-cloud-service/
 ~              content/implementing/developing/edge-functions
 ~
 ~ ── What this function does ──────────────────────────────────────────────────
 ~
 ~   1. Intercepts browser HTML requests for SPA pages at the CDN edge
 ~   2. Fetches the AEM page model JSON from the publish origin
 ~   3. Renders the React SPA to an HTML string using ReactDOMServer.renderToString
 ~   4. Injects the rendered markup into the AEM page template and returns it
 ~      directly to the browser — AEM publish never handles the HTML response
 ~   5. The browser receives pre-rendered HTML; React hydrates the existing DOM
 ~
 ~ ── Architecture ──────────────────────────────────────────────────────────────
 ~
 ~   Browser Request (HTML)
 ~         │
 ~         ▼
 ~   Fastly CDN PoP
 ~     └── Edge Function intercepts *.html requests matching SPA_PAGE_PATTERN
 ~               │
 ~               ├─ Non-SPA or non-HTML? → context.next() → AEM Publish (passthrough)
 ~               │
 ~               ▼
 ~         Fetch page model JSON from AEM Publish origin
 ~         (e.g. /content/mysite/us/en/home.model.json)
 ~               │
 ~               ▼
 ~         ReactDOMServer.renderToString(App)  ← SSR bundle (pre-built)
 ~               │
 ~               ▼
 ~         Return HTML + __INITIAL_STATE__ to browser
 ~               │
 ~               ▼
 ~   Browser — React hydrates pre-rendered DOM (no full re-render)
 ~
 ~ ── Comparison with App Builder approach ────────────────────────────────────
 ~
 ~   App Builder:
 ~     - AEM RemoteContentRenderer POSTs model JSON → action → returns HTML
 ~     - AEM injects HTML → sends to browser
 ~     - Requires OSGi RemoteContentRenderer config
 ~     - OpenWhisk cold-start latency (~500ms first request)
 ~
 ~   Edge Functions (this file):
 ~     - CDN intercepts browser request → fetch model → render → respond
 ~     - No RemoteContentRenderer config needed
 ~     - Always warm (Fastly PoPs are persistent)
 ~     - Lower end-to-end latency (edge → origin model fetch, no AEM SSR round-trip)
 ~
 ~ ── Prerequisites ─────────────────────────────────────────────────────────────
 ~   □ AEM Edge Functions beta access (request at developer.adobe.com/console)
 ~   □ AEM as a Cloud Service
 ~   □ Run: npm run build-with-edge  (from ui.frontend/) to produce dist/edge/ssr-bundle.js
 ~   □ Cloud Manager pipeline configured for Edge Functions deployment
 ~
 ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~*/

// ─────────────────────────────────────────────────────────────────────────────
// Import the pre-built SSR bundle.
//
// This bundle is produced by:
//   cd ui.frontend && npm run build-with-edge
// Output: ui.frontend/dist/edge/ssr-bundle.js
//
// The Adobe Edge Functions build tool bundles this function together with the
// SSR bundle when deploying via Cloud Manager.
// ─────────────────────────────────────────────────────────────────────────────
import { renderToString } from '../../ui.frontend/dist/edge/ssr-bundle.js';

// ─────────────────────────────────────────────────────────────────────────────
// Configuration — adjust these values for your AEM setup
// ─────────────────────────────────────────────────────────────────────────────

/**
 * URL pattern for pages that should be server-side rendered.
 * Matches the same content paths as the App Builder OSGi config pattern:
 *   /content/mysite/(.*)|/conf/mysite/(.*)/settings/wcm/templates/(.*)
 */
const SPA_PAGE_PATTERN = /^\/content\/mysite\//;

/**
 * AEM page model root path — used when header 'page-model-root-url' is absent.
 */
const DEFAULT_PAGE_MODEL_ROOT = '/content/mysite/us/en';

/**
 * Model JSON suffix appended to strip .html and fetch the Sling Model Exporter.
 * AEM's default: replace .html with .model.json
 */
const MODEL_SELECTOR = '.model.json';

// ─────────────────────────────────────────────────────────────────────────────
// Edge Function Handler
//
// Adobe Edge Functions API:
//   export default async function(request, context)
//
// context.next(request) — pass request to AEM publish origin (passthrough)
// context.next() with no args — pass original request through unchanged
// ─────────────────────────────────────────────────────────────────────────────

export default async function handler(request, context) {
    const url = new URL(request.url);
    const path = url.pathname;

    // ── 1. Passthrough filter ────────────────────────────────────────────────
    // Only intercept GET requests for SPA HTML pages.
    // All other requests (assets, JSON, POST, AEM editor, etc.) pass through.
    const isSpaPage = request.method === 'GET'
        && path.endsWith('.html')
        && SPA_PAGE_PATTERN.test(path);

    if (!isSpaPage) {
        return context.next(request);
    }

    // ── 2. AEM editor passthrough ────────────────────────────────────────────
    // When content authors open the page in AEM editor, wcm-mode is EDIT or PREVIEW.
    // We still render SSR (so authors see content), but we pass the HTML from AEM
    // publish rather than our own response so editor overlays load correctly.
    // TODO: Validate this behaviour once beta access is confirmed.
    const wcmMode = request.headers.get('wcm-mode') || 'DISABLED';
    const isInEditor = wcmMode === 'EDIT' || wcmMode === 'PREVIEW';

    try {
        // ── 3. Fetch page model from AEM publish origin ──────────────────────
        // Derive model URL: /content/mysite/us/en/home.html → .../home.model.json
        const modelPath = path.replace('.html', MODEL_SELECTOR);
        const modelUrl = new URL(modelPath, url.origin).toString();

        const modelResponse = await fetch(modelUrl, {
            // 'backend' is the Fastly backend name registered for AEM publish.
            // In Adobe Managed CDN this is pre-configured; adjust if needed.
            backend: 'aem-publish',
            headers: {
                'Accept': 'application/json',
                // Forward auth cookies so protected pages render correctly
                'Cookie': request.headers.get('Cookie') || ''
            }
        });

        if (!modelResponse.ok) {
            // Model fetch failed — fall back to standard AEM publish rendering
            console.error(`[edge-ssr] Model fetch failed: ${modelResponse.status} ${modelUrl}`);
            return context.next(request);
        }

        const model = await modelResponse.json();

        // ── 4. Render SPA to HTML string ─────────────────────────────────────
        const pageModelRootPath = request.headers.get('page-model-root-url')
            || DEFAULT_PAGE_MODEL_ROOT;

        const renderedFragment = renderToString({
            model,
            pagePath: path,
            pageModelRootPath,
            isInEditor,
            requestUrl: url.toString()
        });

        // ── 5. Wrap fragment in AEM page skeleton ────────────────────────────
        // Fetch the AEM-rendered page shell from publish origin (includes
        // <head>, clientlib links, AEM component markup outside #spa-root, etc.)
        // Then inject the SSR fragment into the #spa-root div.
        //
        // TODO: Confirm with Adobe Edge Functions team whether the SDK provides
        // a helper like context.getPageShell() or if we must fetch it manually.
        const shellResponse = await context.next(request);
        const shellHtml = await shellResponse.text();

        // Replace the empty SPA root div with the SSR-rendered content.
        // AEM outputs: <div id="spa-root"></div>  (or with data-sly-resource wrapper)
        const injected = shellHtml.replace(
            /<div\s+id="spa-root"[^>]*><\/div>/,
            `<div id="spa-root">${renderedFragment}</div>`
        );

        return new Response(injected, {
            status: shellResponse.status,
            headers: {
                // Preserve AEM headers (cache-control, set-cookie, etc.)
                ...Object.fromEntries(shellResponse.headers.entries()),
                'Content-Type': 'text/html; charset=utf-8',
                // Custom header — useful for debugging / Fastly logging rules
                'X-SSR': 'edge'
            }
        });

    } catch (error) {
        // ── 6. Graceful fallback ─────────────────────────────────────────────
        // Any unhandled error (React render crash, model parse error, etc.)
        // falls back to AEM publish serving the page as a standard CSR SPA.
        // The user still gets a working page; SSR is a progressive enhancement.
        console.error('[edge-ssr] Render error, falling back to passthrough:', error.message);
        return context.next(request);
    }
}
