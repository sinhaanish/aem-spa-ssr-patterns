# AEM SPA Server-Side Rendering (SSR) via Adobe App Builder

This module implements Server-Side Rendering for an AEM SPA (React) project using **Adobe App Builder (I/O Runtime)**. AEM delegates the SSR render to a serverless action, which returns pre-rendered HTML. The React app then hydrates the existing DOM on the client.

---

## Architecture

```
Browser Request
      │
      ▼
AEM Page (body.html)
  └── <div id="spa-root" data-sly-resource="cq/remote/content/renderer/request/handler">
      │
      │  [AEM Remote Content Renderer sends page model JSON via POST]
      ▼
Adobe App Builder (I/O Runtime)
  └── actions/  (dist/app.js deployed as the SSR action)
        └── ReactDOMServer.renderToString(...)
      │
      │  [Returns rendered HTML string]
      ▼
AEM injects HTML into page response
      │
      ▼
Browser receives fully rendered HTML → React hydrates the DOM
```

**Key files:**

| File | Purpose |
|---|---|
| `src/server/action-entry.js` | Self-contained action entry — handles the I/O Runtime request lifecycle and calls `renderToString` |
| `src/server/aem-processor.functions.js` | Core SSR logic (React renderToString + `__INITIAL_STATE__` injection) |
| `src/index.js` | Client bootstrap — detects `__INITIAL_STATE__` and calls `hydrate` vs `render` |
| `manifest.yml` | App Builder action definition |
| `webpack.config.adobeio.js` | Webpack config that bundles everything into a self-contained `dist/app.js` |
| `ui.config/.../ConfigurationFactoryImpl~mysite.cfg.json` | AEM OSGi config pointing to the SSR endpoint URL |

---

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Node.js | **v20+** | v16/v18 cause issues with `aio-cli` (`File` API not available until Node 20) |
| npm | v10+ | Comes with Node 20 |
| Java | 11 or 17 | Required by Maven |
| Maven | 3.x | For AEM package deployment |
| Docker | Latest | Required for `aio app run --local` only |
| AEM SDK | 6.5+ or AEMaaCS | Running locally on port 4502 |
| Adobe Developer Console | — | App Builder project with I/O Runtime enabled |
| `@adobe/aio-cli` | v11+ | Install globally on Node 20 |

### Install Node 20 and aio-cli

```bash
# If using nvm (recommended)
nvm install 20
nvm alias default 20
nvm use 20

# Install aio-cli globally
npm install -g @adobe/aio-cli

# Verify
node --version   # v20.x.x
aio --version    # @adobe/aio-cli/11.x.x
```

---

## One-Time Setup

### 1. Create an App Builder Project

1. Go to [Adobe Developer Console](https://developer.adobe.com/console)
2. Create a new project → select **App Builder**
3. Add **I/O Runtime** service to the Production workspace
4. Note your **Org**, **Project name**, and **Workspace**

### 2. Configure aio CLI

```bash
# Select your org, project and workspace
aio console org select "<Your Org ID>"
aio console project select "<Your Project Name>"
aio console workspace select "Production"

# Pull workspace credentials into .env
cd ui.frontend
aio app use -g --overwrite
```

This writes `AIO_runtime_auth`, `AIO_runtime_namespace`, and `AIO_runtime_apihost` into `ui.frontend/.env`.

> **Security:** The `.env` file contains secrets — it is listed in `.gitignore` and must never be committed.

### 3. Install dependencies

```bash
cd ui.frontend
npm install
```

---

## Build

The build compiles both the client-side React bundle (for AEM ClientLib) and the server-side SSR action bundle.

```bash
# From ui.frontend/
npm run build-with-ssr
```

This runs three steps:
1. **`react-scripts build`** → creates `build/` (client bundle with all JS/CSS chunks)
2. **`webpack --config webpack.config.adobeio.js`** → compiles `src/server/action-entry.js` into `dist/app.js` (self-contained SSR action, ~1.4MB)
3. **`clientlib --verbose`** → packages the client bundle into `ui.apps/src/main/content/jcr_root/apps/mysite/clientlibs/clientlib-react/`

> **Node version note:** Webpack 4 and react-scripts 4 are incompatible with Node 17+ OpenSSL. The build scripts include `NODE_OPTIONS=--openssl-legacy-provider` to work around this automatically.

---

## Deploy to Adobe I/O Runtime

```bash
# From ui.frontend/
source ~/.nvm/nvm.sh && nvm use 20   # ensure Node 20 is active
NODE_ENV=production aio app deploy
```

On success, the CLI outputs your live action URL:
```
Your deployed actions:
web actions:
  -> https://<namespace>.adobeioruntime.net/api/v1/web/mysite-0.1.0/ssr
```

Copy this URL — you need it for the AEM OSGi config in the next step.

---

## Configure AEM

### 1. Update the Remote Renderer endpoint

Edit [`ui.config/src/main/content/jcr_root/apps/mysite/osgiconfig/config/com.adobe.cq.remote.content.renderer.impl.factory.ConfigurationFactoryImpl~mysite.cfg.json`](../ui.config/src/main/content/jcr_root/apps/mysite/osgiconfig/config/com.adobe.cq.remote.content.renderer.impl.factory.ConfigurationFactoryImpl~mysite.cfg.json):

```json
{
    "getContentPathPattern": "/content/mysite/(.*)|/conf/mysite/(.*)/settings/wcm/templates/(.*)",
    "getRemoteHTMLRendererUrl": "https://<namespace>.adobeioruntime.net/api/v1/web/mysite-0.1.0/ssr",
    "getRequestTimeout": 10000,
    "getAdditionalRequestHeaders": [],
    "getCompression": "none"
}
```

Replace `<namespace>` with your actual App Builder namespace (e.g. `644509-433azurechameleon`).

### 2. Deploy the updated config to AEM

```bash
# From project root
mvn clean install -pl ui.config -PautoInstallPackage
```

Or to deploy everything at once:
```bash
mvn clean install -PautoInstallSinglePackage
```

---

## Verify SSR is Working

1. Open any SPA page in AEM, e.g. `http://localhost:4502/content/mysite/us/en/home.html`
2. Right-click → **View Page Source**
3. Find `<div id="spa-root">` — it should contain rendered HTML (navigation, text, footer), **not** an empty div
4. The `<script type="application/json" id="__INITIAL_STATE__">` tag should be present
5. Open browser DevTools → Console — you should see `hydrated react DOM` (React hydrated the pre-rendered HTML instead of re-rendering)
6. Disable JavaScript in your browser — the page should still show meaningful content (the SSR payoff)

### Quick curl test

```bash
# Fetch page model from AEM, send to SSR action, check for rendered HTML
MODEL=$(curl -s "http://localhost:4502/content/mysite/us/en/home.model.json" -u admin:admin)

curl -s -X POST "https://<namespace>.adobeioruntime.net/api/v1/web/mysite-0.1.0/ssr/content/mysite/us/en/home.html" \
  -H "Content-Type: application/json" \
  -H "page-model-root-url: /content/mysite/us/en" \
  -H "wcm-mode: DISABLED" \
  -d "$MODEL" | head -5
```

Expected output starts with rendered HTML like `<div><div class="aem-container...`.

---

## Day-to-Day Development Workflow

When you make changes to React components:

```bash
# 1. Rebuild both client and SSR bundles
cd ui.frontend
npm run build-with-ssr

# 2. Redeploy the SSR action
NODE_ENV=production aio app deploy

# 3. Redeploy client bundle to AEM
cd ..
mvn clean install -pl ui.apps -PautoInstallPackage
```

---

## Local Development (Express — Recommended for Apple Silicon Macs)

> **Note:** `aio app run --local` uses a Docker-based OpenWhisk stack (AMD64 image). On Apple Silicon (M1/M2/M3) Macs, this runs under Rosetta emulation and has known stability issues. Use the Express-based local server instead.

```bash
# 1. Build the Express SSR bundle
npm run build-with-express

# 2. Start the Express SSR server (runs on port 3233)
npm run start-ssr-express
```

Then temporarily point the AEM OSGi config to `http://localhost:3233/api/v1/web/guest/mysite-0.1.0/ssr` for local testing.

---

## How SSR Works — Step by Step

### 1. AEM triggers the render chain

`ui.apps/src/main/content/.../components/page/body.html`:
```html
<div id="spa-root"
     data-sly-resource="${resource @ resourceType='cq/remote/content/renderer/request/handler'}">
</div>
```

The `RemoteContentRendererRequestHandlerServlet` reads the OSGi config, fetches the page model JSON from AEM's Sling Model Exporter, and POSTs it to the configured `getRemoteHTMLRendererUrl`.

### 2. App Builder action renders HTML

`src/server/action-entry.js` receives the POST, extracts the model from the request args, and calls `ReactDOMServer.renderToString(...)` with the `App` component.

The rendered HTML is returned along with an `__INITIAL_STATE__` script tag containing the serialized page model.

### 3. AEM injects the HTML

AEM's Remote Content Renderer inserts the returned HTML string into the `<div id="spa-root">`.

### 4. React hydrates on the client

`src/index.js` detects `__INITIAL_STATE__`, parses it, and calls `ReactDOM.hydrate(...)` instead of `ReactDOM.render(...)`. This attaches React event handlers to the existing DOM without re-rendering — resulting in faster Time-to-Interactive.

---

## Webpack Build — Key Design Decisions

The SSR action (`dist/app.js`) is built as a **fully self-contained bundle** with no external dependencies. This is critical because the App Builder action runtime has no access to `node_modules`.

Key settings in `webpack.config.adobeio.js`:

```javascript
entry: ['./src/server/action-entry.js'],  // single clean entry (no circular deps)
target: 'node',
// No externals — all deps bundled (React, AEM libs, pako, etc.)
output: {
    filename: 'app.js',
    libraryTarget: 'commonjs2'  // exports as module.exports — required by I/O Runtime
}
```

> **Why `libraryTarget: 'commonjs2'`?** Adobe I/O Runtime discovers the action entry point via `require('./app.js').main`. Using `commonjs2` ensures `module.exports = { main }` is set correctly. The original `library: 'ssr'` config exported as `exports.ssr = ...` which the runtime couldn't find.

> **Why a new `action-entry.js`?** The original `actions/ssr/index.js` required `../common/app` which was a separately built webpack bundle. Bundling that into a new bundle created a recursive dependency. `action-entry.js` imports directly from source (`aem-processor.functions.js`) and is the single webpack entry, producing a clean non-circular bundle.

---

## Troubleshooting

### `error:0308010C:digital envelope routines::unsupported`
**Cause:** Node 17+ uses OpenSSL 3 which removed legacy hash algorithms needed by Webpack 4.  
**Fix:** Already applied in `package.json` — all build scripts include `NODE_OPTIONS=--openssl-legacy-provider`.

### `File is not defined` when running `aio app use -g`
**Cause:** The `File` Web API global was added in Node 20. Running `aio-cli` on Node 16 or 18 fails.  
**Fix:** Use Node 20.
```bash
nvm install 20 && nvm use 20
npm install -g @adobe/aio-cli
aio app use -g --overwrite
```

### `missing Adobe I/O Runtime namespace` on deploy
**Cause:** The `.env` file is missing runtime credentials.  
**Fix:** Run `aio app use -g --overwrite` from `ui.frontend/` after selecting the correct org/project/workspace.

### `The action did not initialize and exited unexpectedly` (local OpenWhisk)
**Cause:** On Apple Silicon Macs, the OpenWhisk Docker image (`adobe-action-nodejs-v14`, AMD64) runs under Rosetta emulation and fails silently during init.  
**Fix:** Use the Express-based local server (`npm run start-ssr-express`) or deploy directly to Adobe I/O Runtime.

### AEM page shows `totalTime: 10047` in page source
**Cause:** AEM timed out waiting for the SSR action (10-second default timeout).  
**Likely causes:**
- The SSR action isn't deployed or the URL is wrong
- The OSGi config hasn't been redeployed to AEM after changing the URL
- The action is cold-starting (first request after idle) — subsequent requests will be faster

### SSR returns HTML but `__INITIAL_STATE__` contains `__ow_headers`
**Cause:** When AEM POSTs JSON, the OpenWhisk runtime merges the request body with action args. The `data = args` branch in `action-entry.js` passes the entire args object (including `__ow_*` fields) as the model.  
**Impact:** Harmless — the extra fields are ignored by `ModelManager`. The rendered HTML is correct.  
**Fix (optional):** Strip `__ow_*` keys before passing to `processSPA`.

---

## npm Scripts Reference

| Script | Command | Description |
|---|---|---|
| `build-with-ssr` | `react-scripts build && webpack --config webpack.config.adobeio.js && clientlib` | Full build: client bundle + SSR action bundle + AEM clientlib |
| `build-with-express` | `react-scripts build && webpack --config webpack.config.express.js && clientlib` | Full build using Express server instead of I/O Runtime |
| `start-ssr-ioruntime` | `aio app run --local` | Start local OpenWhisk (Docker). Not recommended on Apple Silicon. |
| `start-ssr-express` | `node dist/express.js` | Start Express SSR server on port 3233. Recommended for local dev. |
| `deploy-ssr-ioruntime` | `aio app deploy` | Deploy SSR action to Adobe I/O Runtime |
| `start` | `react-scripts start` | Start React dev server (client-side only, no SSR) |
| `sync` | `aemsync` | Live-sync frontend changes to local AEM |
