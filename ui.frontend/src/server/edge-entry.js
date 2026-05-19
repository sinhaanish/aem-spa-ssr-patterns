/*~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
 ~ AEM SPA SSR — Edge Functions entry point
 ~
 ~ This module is the webpack entry for the Edge SSR bundle.
 ~ It is imported by the AEM Edge Function (edge-functions/ssr/index.js) and
 ~ runs inside the Adobe Managed CDN (Fastly Compute JavaScript runtime).
 ~
 ~ KEY DIFFERENCES from App Builder (action-entry.js):
 ~   - ES module syntax (not CommonJS require/module.exports)
 ~   - No pako decompression — edge receives plain JSON from AEM publish, not
 ~     the compressed binary payload that AEM Remote Content Renderer sends
 ~   - No __ow_* headers — edge function receives the raw browser request
 ~   - ModelManager.initialize() called synchronously (model already in hand)
 ~   - Target runtime: webworker (browser-like globals, no Node.js Buffer/process)
 ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~*/

import 'regenerator-runtime/runtime';
import React from 'react';
import ReactDOMServer from 'react-dom/server';
import { StaticRouter } from 'react-router-dom';
import { Constants, EditorContext } from '@adobe/aem-react-editable-components';
import { ModelManager } from '@adobe/aem-spa-page-model-manager';
import App from '../App';
import '../components/import-components';

/**
 * Render the AEM SPA model to an HTML string.
 *
 * @param {object} options
 * @param {object} options.model           - AEM page model JSON (already fetched)
 * @param {string} options.pagePath        - e.g. "/content/mysite/us/en/home.html"
 * @param {string} options.pageModelRootPath - e.g. "/content/mysite/us/en"
 * @param {boolean} options.isInEditor     - true when wcm-mode is EDIT/PREVIEW
 * @param {string} options.requestUrl      - full request URL string (for StaticRouter)
 * @returns {string} rendered HTML fragment + __INITIAL_STATE__ script tag
 */
export function renderToString({ model, pagePath, pageModelRootPath, isInEditor, requestUrl }) {
    const cleanPagePath = pagePath.replace('.html', '');
    const rootPath = pageModelRootPath || '/content/mysite/us/en';

    // Initialise ModelManager with the pre-fetched model so it does not
    // attempt any XHR calls (which are unavailable in the edge runtime).
    ModelManager.initialize({ path: rootPath, model });

    const html = ReactDOMServer.renderToString(
        <StaticRouter location={requestUrl || pagePath} context={{}}>
            <EditorContext.Provider value={isInEditor || false}>
                <App
                    cqChildren={model[Constants.CHILDREN_PROP]}
                    cqItems={model[Constants.ITEMS_PROP]}
                    cqItemsOrder={model[Constants.ITEMS_ORDER_PROP]}
                    cqPath={rootPath}
                    locationPathname={pagePath}
                />
            </EditorContext.Provider>
        </StaticRouter>
    );

    // Embed the initial model so the client-side React can hydrate
    // instead of re-fetching the model and re-rendering.
    const state = {
        rootModel: model,
        rootModelUrl: ModelManager.rootPath,
        pagePath: cleanPagePath
    };

    return `${html}
    <script type="application/json" id="__INITIAL_STATE__">
        ${JSON.stringify(state)}
    </script>`;
}
