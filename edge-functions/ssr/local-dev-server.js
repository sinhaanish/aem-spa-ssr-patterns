/*~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
 ~ Edge Functions SSR — Local development server
 ~
 ~ Mimics the AEM Edge Function handler using Express so you can test SSR
 ~ locally without deploying to Fastly CDN or needing beta access.
 ~
 ~ Listens on: http://localhost:3234
 ~
 ~ How to use:
 ~   1. Build the edge SSR bundle:   cd ui.frontend && npm run build-edge-only
 ~   2. Start local AEM on port 4502 (author) or 4503 (publish)
 ~   3. Run: node edge-functions/ssr/local-dev-server.js
 ~   4. Configure AEM OSGi RemoteContentRenderer to point to:
 ~        http://localhost:3234
 ~      OR open a page directly:
 ~        curl http://localhost:3234/content/mysite/us/en/home.html
 ~
 ~ The server proxies model JSON requests to AEM_ORIGIN (default: localhost:4502).
 ~ Change AEM_ORIGIN below to point to your AEM publish instance if preferred.
 ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~*/

const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

// ── Configuration ─────────────────────────────────────────────────────────────
const PORT = 3234;
const AEM_ORIGIN = process.env.AEM_ORIGIN || 'http://localhost:4502';
const AEM_CREDENTIALS = process.env.AEM_CREDENTIALS || 'admin:admin';
const SPA_PAGE_PATTERN = /^\/content\/mysite\//;

// ── Load the pre-built edge SSR bundle ────────────────────────────────────────
const bundlePath = path.resolve(__dirname, '../../ui.frontend/dist/edge/ssr-bundle.js');
let renderToString;
try {
    ({ SSRBundle: { renderToString } } = { SSRBundle: require(bundlePath) });
    // UMD export: require(bundle) returns the library object
    // Try both UMD export shapes
    if (!renderToString) {
        const bundle = require(bundlePath);
        renderToString = bundle.renderToString || (bundle.SSRBundle && bundle.SSRBundle.renderToString);
    }
    console.log('✅ Edge SSR bundle loaded:', bundlePath);
} catch (err) {
    console.error('❌ Failed to load SSR bundle:', bundlePath);
    console.error('   Run: cd ui.frontend && npm run build-edge-only');
    console.error(err.message);
    process.exit(1);
}

// ── Express server ────────────────────────────────────────────────────────────
const app = express();

app.get('*', async (req, res) => {
    const pagePath = req.path;

    // Only intercept SPA HTML pages
    if (!pagePath.endsWith('.html') || !SPA_PAGE_PATTERN.test(pagePath)) {
        // Proxy everything else to AEM
        return res.redirect(302, `${AEM_ORIGIN}${pagePath}${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`);
    }

    const wcmMode = req.headers['wcm-mode'] || 'DISABLED';
    const isInEditor = wcmMode === 'EDIT' || wcmMode === 'PREVIEW';
    const pageModelRootPath = req.headers['page-model-root-url'] || '/content/mysite/us/en';

    try {
        // Step 1: Fetch page model from AEM
        const modelPath = pagePath.replace('.html', '.model.json');
        const modelUrl = `${AEM_ORIGIN}${modelPath}`;

        console.log(`[edge-ssr-local] Fetching model: ${modelUrl}`);
        const modelResponse = await fetch(modelUrl, {
            headers: {
                'Accept': 'application/json',
                'Authorization': `Basic ${Buffer.from(AEM_CREDENTIALS).toString('base64')}`
            }
        });

        if (!modelResponse.ok) {
            console.error(`[edge-ssr-local] Model fetch failed: ${modelResponse.status}`);
            return res.status(502).send(`Model fetch failed: ${modelResponse.status} ${modelUrl}`);
        }

        const model = await modelResponse.json();

        // Step 2: Render with React SSR
        const renderedFragment = renderToString({
            model,
            pagePath,
            pageModelRootPath,
            isInEditor,
            requestUrl: `${AEM_ORIGIN}${pagePath}`
        });

        // Step 3: Fetch the AEM page HTML shell (head, clientlibs, etc.)
        const shellUrl = `${AEM_ORIGIN}${pagePath}`;
        console.log(`[edge-ssr-local] Fetching shell: ${shellUrl}`);
        const shellResponse = await fetch(shellUrl, {
            headers: {
                'Authorization': `Basic ${Buffer.from(AEM_CREDENTIALS).toString('base64')}`,
                // Prevent recursive SSR trigger if this server is also set as RemoteContentRenderer
                'X-Skip-Edge-SSR': 'true'
            }
        });

        const shellHtml = await shellResponse.text();

        // Step 4: Inject SSR fragment into #spa-root
        const injected = shellHtml.replace(
            /<div\s+id="spa-root"[^>]*><\/div>/,
            `<div id="spa-root">${renderedFragment}</div>`
        );

        console.log(`[edge-ssr-local] ✅ SSR rendered ${pagePath} (fragment: ${renderedFragment.length} chars)`);

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('X-SSR', 'edge-local');
        res.send(injected);

    } catch (err) {
        console.error('[edge-ssr-local] Render error:', err.message);
        res.status(500).send(`SSR Error: ${err.message}\n\n${err.stack}`);
    }
});

app.listen(PORT, () => {
    console.log('');
    console.log('╔═══════════════════════════════════════════════════╗');
    console.log('║  AEM Edge Functions SSR — Local Dev Server        ║');
    console.log(`║  Listening on http://localhost:${PORT}               ║`);
    console.log(`║  Proxying model requests to: ${AEM_ORIGIN.padEnd(20)} ║`);
    console.log('╚═══════════════════════════════════════════════════╝');
    console.log('');
    console.log('Test with:');
    console.log(`  curl -s http://localhost:${PORT}/content/mysite/us/en/home.html | grep -o 'id="spa-root"[^<]*'`);
    console.log('');
});
