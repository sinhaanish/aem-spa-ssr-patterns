# AEM Edge Functions — SPA Server-Side Rendering

This edge function implements **SSR for an AEM React SPA** running on **Adobe Managed CDN (Fastly Compute JavaScript)**. It intercepts browser requests at the CDN edge, fetches the AEM page model, renders React to HTML, and delivers fully pre-rendered markup directly to the browser.

> **Status:** Requires AEM Edge Functions beta access.  
> Request access at [Adobe Developer Console](https://developer.adobe.com/console).

---

## Architecture

```
Browser Request (GET /content/mysite/.../page.html)
      │
      ▼
Fastly CDN PoP ← AEM Edge Function active here
  │
  ├── Non-SPA URL? → passthrough → AEM Publish (unchanged)
  │
  ▼
Edge Function: edge-functions/ssr/index.js
  │
  ├── Fetch page model from AEM Publish:
  │     GET /content/mysite/.../page.model.json  (Sling Model Exporter)
  │
  ├── ReactDOMServer.renderToString(App)
  │     uses: ui.frontend/dist/edge/ssr-bundle.js  (pre-built)
  │
  ├── Fetch page HTML shell from AEM Publish (layout, head, clientlibs)
  │
  ├── Inject SSR fragment into <div id="spa-root">...</div>
  │
  └── Return fully-rendered HTML to browser
        │
        ▼
Browser — React hydrates pre-rendered DOM using __INITIAL_STATE__
```

---

## Comparison: App Builder vs Edge Functions

| | App Builder (`feature/appbuilder-ssr`) | Edge Functions (this branch) |
|---|---|---|
| **Trigger** | AEM RemoteContentRenderer POSTs model | CDN intercepts browser request |
| **Model fetch** | AEM fetches & sends model to action | Edge fetches model from AEM origin |
| **Runtime** | OpenWhisk Node.js 18 | Fastly Compute JavaScript |
| **Deploy** | `aio app deploy` | Cloud Manager pipeline |
| **Cold start** | ~500 ms (first request after idle) | None (Fastly PoPs always warm) |
| **Latency** | AEM → App Builder → AEM → Browser | Edge → AEM origin → Browser |
| **AEM config** | OSGi RemoteContentRenderer config | URL pattern in Cloud Manager |
| **Beta needed** | No | **Yes** |

---

## Prerequisites

| Requirement | Notes |
|---|---|
| AEM as a Cloud Service | Required — Edge Functions not available for AEM 6.5 |
| Edge Functions beta access | Request at [Adobe Developer Console](https://developer.adobe.com/console) |
| Cloud Manager pipeline | Must be configured for Edge Functions |
| Node.js 20 | For building the SSR bundle |
| npm 10+ | Comes with Node 20 |

---

## One-Time Setup

### 1. Install new dependencies for the edge build

```bash
cd ui.frontend
npm install
```

The following new devDependencies have been added to `package.json` for the edge build:
- `null-loader` — discards CSS/SCSS imports (no DOM on edge)
- `stream-browserify`, `buffer`, `process`, `util` — Node.js built-in polyfills

### 2. Build the SSR edge bundle

```bash
cd ui.frontend
npm run build-with-edge
```

This runs:
1. `react-scripts build` → client bundle for AEM ClientLib
2. `webpack --config webpack.config.edge.js` → `dist/edge/ssr-bundle.js`
3. `clientlib` → packages client bundle into AEM

The edge bundle (`dist/edge/ssr-bundle.js`) is ~1.5 MB and contains React + all AEM SPA libraries self-contained.

> **To rebuild only the edge bundle (without the full React build):**
> ```bash
> npm run build-edge-only
> ```

---

## Deploy to Adobe Managed CDN

> **Beta access required.** Steps below are based on Adobe documentation and may evolve during the beta programme.

### 1. Configure the edge function in Cloud Manager

Once you have beta access, add an edge function configuration to your AEM as a Cloud Service project. The exact configuration format will be provided by Adobe's beta documentation, but it typically looks like:

```yaml
# cloud-manager-edge-functions.yml (location TBD by Adobe)
edgeFunctions:
  - name: spa-ssr
    path: edge-functions/ssr/index.js
    urlPattern: "/content/mysite/**/*.html"
```

### 2. Commit and push

```bash
git add edge-functions/
git add ui.frontend/dist/edge/ssr-bundle.js
git commit -m "feat: add Edge Functions SSR bundle"
git push origin feature/edge-functions-ssr
```

### 3. Run Cloud Manager pipeline

Trigger a deployment pipeline in Cloud Manager. The edge function is deployed to all Fastly PoPs automatically.

---

## Local Testing

Unlike App Builder (which uses `aio app run --local`), AEM Edge Functions do not have an official local emulator yet (beta limitation). Two workarounds:

### Option A — Express local server (recommended)

A local Express server mimics the edge function handler for development:

```bash
cd ui.frontend
npm run build-edge-only       # build dist/edge/ssr-bundle.js
node ../edge-functions/ssr/local-dev-server.js
```

The server runs on port 3234 and proxies model requests to `http://localhost:4502`.

> `local-dev-server.js` is in `edge-functions/ssr/` — see next section.

### Option B — curl test against live AEM publish

If you have an AEM publish instance running:

```bash
# Fetch model and render directly via the SSR bundle
MODEL=$(curl -s "http://localhost:4503/content/mysite/us/en/home.model.json")
node -e "
  const { renderToString } = require('./ui.frontend/dist/edge/ssr-bundle.js');
  const html = renderToString({
    model: $MODEL,
    pagePath: '/content/mysite/us/en/home.html',
    pageModelRootPath: '/content/mysite/us/en',
    isInEditor: false,
    requestUrl: 'http://localhost/content/mysite/us/en/home.html'
  });
  console.log(html.substring(0, 500));
"
```

Expected output: rendered HTML starting with `<div class="...`

---

## How the Code is Structured

```
edge-functions/
  ssr/
    index.js              ← Edge function handler (AEM Edge Functions API)
    local-dev-server.js   ← Express wrapper for local testing
    README.md             ← This file

ui.frontend/
  src/server/
    edge-entry.js         ← SSR bundle entry (ES module, shared render logic)
    action-entry.js       ← App Builder bundle entry (CommonJS, different adapter)
  webpack.config.edge.js  ← Webpack config for edge SSR bundle
  dist/
    edge/
      ssr-bundle.js       ← Built edge bundle (committed to git for Cloud Manager)
```

The SSR rendering logic in `edge-entry.js` is intentionally kept close to `action-entry.js`. Both call `ReactDOMServer.renderToString` with the same App component — the difference is only in the adapter layer (how the model arrives and how the response is sent).

---

## Key Design Decisions

### Why a separate `edge-entry.js` instead of reusing `action-entry.js`?

`action-entry.js` uses CommonJS `require()` and handles the OpenWhisk request protocol (`__ow_headers`, `pako` decompression of binary payloads). The edge function receives a standard HTTP request — no `__ow_*` wrapping, no binary compression. A clean entry point avoids protocol confusion.

### Why `target: 'webworker'` in webpack?

Fastly Compute JavaScript runs in a WebAssembly sandbox with a Web Worker-like global scope: `fetch`, `Request`, `Response`, `TextEncoder` are available but `Buffer`, `process`, and Node.js built-ins are not. The `webworker` target tells webpack to not inject Node.js shims while still bundling everything.

### Why bundle the SSR logic separately from the edge function?

The edge function (`index.js`) handles CDN routing logic (intercept, fetch shell, inject). The SSR bundle (`ssr-bundle.js`) handles React rendering. Keeping them separate means:
1. You can update React components without touching CDN routing logic
2. The SSR bundle can be tested in isolation with a simple `require()` test
3. Future: the same SSR bundle could be used for other renderers

### Why is the SSR bundle committed to git?

Cloud Manager deploys whatever is in the git repository. The bundle must be pre-built and committed (similar to how AEM clientlib output is typically committed). Add `ui.frontend/dist/edge/` to your `.gitignore` exclusion list but keep `ui.frontend/dist/edge/ssr-bundle.js` tracked.

---

## Troubleshooting

### Edge function not intercepting requests

- Verify the `urlPattern` in your Cloud Manager edge function config matches your SPA content paths
- Check that `SPA_PAGE_PATTERN` in `index.js` covers your page paths

### `renderToString` throws in edge runtime

- Most likely a component uses `window`, `document`, or `localStorage` — these don't exist on edge
- Wrap browser-only code in `typeof window !== 'undefined'` guards
- Check the browser DevTools console for hydration warnings after deploying

### Model fetch returns 401

- The edge function's `fetch` to `*.model.json` may need auth if publish is protected
- Forward the `Cookie` header from the browser request (already done in `index.js`)
- For production, configure AEM publish dispatcher to allow `/**.model.json` without auth

### SSR fragment not injected (spa-root stays empty)

- The regex in `index.js` expects `<div id="spa-root"></div>` (no whitespace inside)
- Check your AEM `body.html` template — update the regex if needed

### `Cannot find module 'stream-browserify'` during build

Run `npm install` in `ui.frontend/` — the new polyfill devDependencies need to be installed.

---

## What to do when beta access is granted

1. Review the official Adobe Edge Functions SDK documentation for any API changes
2. Update the `context.next()` call if the passthrough API differs from what's scaffolded
3. Run `npm run build-edge-only` to build the SSR bundle
4. Configure Cloud Manager with the edge function URL pattern
5. Deploy via pipeline and verify with `curl -I https://your-publish.adobeaemcloud.com/content/mysite/us/en/home.html` — look for `x-ssr: edge` response header
