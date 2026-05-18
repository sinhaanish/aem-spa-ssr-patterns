require("regenerator-runtime/runtime");
const pako = require('pako');
const React = require('react');
const ReactDOMServer = require('react-dom/server');
const { StaticRouter } = require('react-router-dom');
const { Constants, EditorContext } = require('@adobe/aem-react-editable-components');
const { ModelManager } = require('@adobe/aem-spa-page-model-manager');
const App = require('../App').default;
require('../components/import-components');

function renderModelToHTMLString(model, pagePath, requestUrl, requestPath, pageModelRootPath, isInEditor) {
    const html = ReactDOMServer.renderToString(
        React.createElement(StaticRouter, { location: requestUrl, context: {} },
            React.createElement(EditorContext.Provider, { value: isInEditor },
                React.createElement(App, {
                    cqChildren: model[Constants.CHILDREN_PROP],
                    cqItems: model[Constants.ITEMS_PROP],
                    cqItemsOrder: model[Constants.ITEMS_ORDER_PROP],
                    cqPath: pageModelRootPath,
                    locationPathname: requestPath
                })
            )
        )
    );

    const state = { rootModel: model, rootModelUrl: ModelManager.rootPath, pagePath };
    return `${html}
     <script type="application/json" id="__INITIAL_STATE__">
         ${JSON.stringify(state)}
     </script>`;
}

async function processSPA(args) {
    const APP_ROOT_PATH = '/content/mysite/us/en';
    const wcmMode = args.wcmmode;
    const isInEditor = wcmMode && (wcmMode === 'EDIT' || wcmMode === 'PREVIEW');
    const pageModelRootPath = args.pageRoot || APP_ROOT_PATH;
    let modelData = args.data;
    let pagePath = args.pagePath.replace('.html', '');

    await ModelManager.initialize({ path: pageModelRootPath, model: modelData });
    return renderModelToHTMLString(modelData, pagePath, args.pagePath, args.pagePath, pageModelRootPath, isInEditor);
}

async function main(args) {
    var data;
    if (args.__ow_headers && args.__ow_headers['content-type'] === "application/octet-stream") {
        data = Buffer.from(pako.inflate(Buffer.from(args.__ow_body, 'base64')), "base64").toString();
    } else {
        data = args;
    }

    const refinedArgs = {
        data: data,
        pageRoot: args.__ow_headers && args.__ow_headers['page-model-root-url'],
        pagePath: args.__ow_path,
        wcmmode: args.__ow_headers && args.__ow_headers['wcm-mode']
    };

    try {
        const response = await processSPA(refinedArgs);
        return {
            headers: { 'Content-Type': 'text/html' },
            statusCode: 200,
            body: response
        };
    } catch (err) {
        console.error("SSR Error:", err);
        return {
            statusCode: 500,
            body: { error: err.message, stack: err.stack }
        };
    }
}

module.exports = { main };
