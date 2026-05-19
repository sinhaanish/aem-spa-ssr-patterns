/*~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
 ~ AEM Edge Function — Server-Side Rendering for React SPA
 ~
 ~ Runtime:     Adobe Managed CDN (Fastly Compute JavaScript)
 ~ Deploy:      aio aem edge-functions deploy spa-ssr
 ~ Environment: p50155-e2062060 (sandbox dev)
 ~
 ~ ── How traffic reaches this function ───────────────────────────────────────
 ~
 ~   CDN origin selector rule (config/cdn.yaml) routes all requests matching
 ~   /content/mysite/**\/*.html  →  originName: edgefunction-spa-ssr
 ~   This function IS the origin for those URLs — it owns the full response.
 ~
 ~ ── What this function does ──────────────────────────────────────────────────
 ~
 ~   1. Receives GET request for a SPA HTML page
 ~   2. Fetches page model JSON from AEM publish (backend: aem-publish)
 ~   3. Renders React SPA to HTML using pre-built SSR bundle
 ~   4. Fetches AEM page HTML shell (head, clientlibs, surrounding markup)
 ~   5. Injects rendered fragment into <div id="spa-root">
 ~   6. Returns fully rendered HTML to browser
 ~   7. React hydrates DOM client-side — no blank flash, SEO-friendly
 ~
 ~ ── Build & Deploy ───────────────────────────────────────────────────────────
 ~
 ~   # 1. Build SSR bundle (run from ui.frontend/)
 ~   npm run build-edge-only
 ~
 ~   # 2. Install edge function deps (run from edge-functions/ssr/, only once)
 ~   npm install
 ~
 ~   # 3. Setup aio CLI (only once)
 ~   aio plugins install @adobe/aio-cli-plugin-aem-edge-functions
 ~   aio aem edge-functions setup    # select program 50155, env 2062060
 ~
 ~   # 4. Build + deploy
 ~   aio aem edge-functions build
 ~   aio aem edge-functions deploy spa-ssr
 ~
 ~   # 5. Tail live logs
 ~   aio aem edge-functions tail-logs spa-ssr
 ~
 ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~*/

/// <reference types="@fastly/js-compute" />

// Import the pre-built SSR bundle (CommonJS2, ~427 KB).
// Built by: cd ui.frontend && npm run build-edge-only
// esbuild (inside js-compute-runtime) handles CJS interop automatically.
import ssrBundle from '../../../ui.frontend/dist/edge/ssr-bundle.js';

const { renderToString } = ssrBundle;

// ── Configuration ─────────────────────────────────────────────────────────────

// Origin name must match config/edgeFunctions.yaml origins[].name
const AEM_PUBLISH_BACKEND = 'aem-publish';

// Default page model root — can be overridden per-request via header
const DEFAULT_PAGE_MODEL_ROOT = '/content/mysite/us/en';

// ── Fastly Compute JS entry point ─────────────────────────────────────────────

addEventListener('fetch', (event) => event.respondWith(handleRequest(event)));

async function handleRequest(event) {
    const req = event.request;
    const url = new URL(req.url);
    const path = url.pathname;

    // ── 1. Safety check ───────────────────────────────────────────────────────
    // CDN routing already filters to HTML pages but be defensive.
    if (req.method !== 'GET' || !path.endsWith('.html')) {
        return await fetch(req, { backend: AEM_PUBLISH_BACKEND });
    }

    // ── 2. Read WCM mode ──────────────────────────────────────────────────────
    const wcmMode = req.headers.get('wcm-mode') || 'DISABLED';
    const isInEditor = wcmMode === 'EDIT' || wcmMode === 'PREVIEW';

    try {
        // ── 3. Fetch page model from AEM publish ──────────────────────────────
        const modelPath = path.replace('.html', '.model.json');
        const modelRequest = new Request(`${url.origin}${modelPath}`, {
            headers: { 'Accept': 'application/json' }
        });

        const modelResponse = await fetch(modelRequest, {
            backend: AEM_PUBLISH_BACKEND
        });

        if (!modelResponse.ok) {
            console.log(`[spa-ssr] Model fetch failed ${modelResponse.status} — fallback`);
            return await fetch(req, { backend: AEM_PUBLISH_BACKEND });
        }

        const model = await modelResponse.json();

        // ── 4. Render React SPA to HTML ───────────────────────────────────────
        const pageModelRootPath = req.headers.get('page-model-root-url')
            || DEFAULT_PAGE_MODEL_ROOT;

        const renderedFragment = renderToString({
            model,
            pagePath: path,
            pageModelRootPath,
            isInEditor,
            requestUrl: url.toString()
        });

        // ── 5. Fetch AEM page HTML shell ──────────────────────────────────────
        // Gets the full page HTML from AEM publish (with empty spa-root div).
        const shellResponse = await fetch(req, { backend: AEM_PUBLISH_BACKEND });
        const shellHtml = await shellResponse.text();

        // ── 6. Inject SSR fragment into #spa-root ─────────────────────────────
        const injected = shellHtml.replace(
            /<div\s+id="spa-root"[^>]*><\/div>/,
            `<div id="spa-root">${renderedFragment}</div>`
        );

        console.log(`[spa-ssr] OK ${path} (${renderedFragment.length} chars)`);

        return new Response(injected, {
            status: shellResponse.status,
            headers: {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': shellResponse.headers.get('Cache-Control') || 'no-store',
                'X-SSR': 'edge'
            }
        });

    } catch (error) {
        // ── 7. Graceful fallback ──────────────────────────────────────────────
        // On any error fall back to AEM publish CSR — user still gets a page.
        console.log(`[spa-ssr] Error on ${path}: ${error.message} — fallback`);
        return await fetch(req, { backend: AEM_PUBLISH_BACKEND });
    }
}
