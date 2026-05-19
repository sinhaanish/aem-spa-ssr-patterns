/*~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
 ~ webpack.config.edge.js
 ~
 ~ Builds the SSR bundle for the AEM Edge Functions runtime.
 ~
 ~ TARGET RUNTIME: Adobe Managed CDN — Fastly Compute JavaScript
 ~   - Browser-like globals (fetch, Request, Response, TextEncoder…)
 ~   - NO Node.js Buffer, process, fs, path etc.
 ~   - NO CommonJS require() at runtime — bundle must be self-contained
 ~   - Uses ES module import/export
 ~
 ~ OUTPUT: dist/edge/ssr-bundle.js
 ~   Imported by edge-functions/ssr/index.js, which is deployed via Cloud Manager.
 ~
 ~ DIFFERENCES vs webpack.config.adobeio.js (App Builder bundle):
 ~   - target: 'webworker'  (not 'node')
 ~   - libraryTarget: 'umd' (importable from both ESM and the edge build tool)
 ~   - null-loader for CSS/SCSS (no DOM on edge)
 ~   - Node.js built-in polyfills via resolve.fallback
 ~   - NODE_OPTIONS=--openssl-legacy-provider still required (Webpack 4 + Node 17+)
 ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~*/

const path = require('path');
const webpack = require('webpack');
const CleanWebpackPlugin = require('clean-webpack-plugin');

module.exports = {
    // SSR bundle entry — ES-module style, no __ow_* protocol, no pako
    entry: ['./src/server/edge-entry.js'],

    // webworker = browser globals available, no Node.js internals
    target: 'webworker',

    mode: 'production',

    output: {
        filename: 'ssr-bundle.js',
        path: path.resolve(__dirname, 'dist/edge'),
        // UMD so the bundle can be required() by the edge function build tool
        // or imported as a module if the toolchain supports it.
        library: 'SSRBundle',
        libraryTarget: 'umd',
        // Make UMD work in both browser and worker global scopes
        globalObject: 'typeof self !== "undefined" ? self : this'
    },

    devtool: 'source-map',

    resolve: {
        extensions: ['.js', '.jsx'],
        // Polyfill Node built-ins that AEM SPA SDK references but Fastly doesn't have.
        // webpack 4 uses resolve.alias for polyfills (webpack 5 uses resolve.fallback).
        alias: {
            stream: require.resolve('stream-browserify'),
            buffer: require.resolve('buffer/'),
            util: require.resolve('util/')
        }
    },

    // webpack 4 node-config: tell webpack to provide browser replacements for Node globals
    node: {
        // Buffer and process are provided via ProvidePlugin below
        Buffer: false,
        process: false,
        // The following are not used by the SPA SDK — disable polyfilling them
        fs: 'empty',
        net: 'empty',
        tls: 'empty',
        path: false,
        os: false,
        http: false,
        https: false
    },

    module: {
        rules: [
            {
                test: /\.jsx?$/,
                enforce: 'post',
                loader: require.resolve('babel-loader'),
                options: {
                    babelrc: false,
                    presets: [
                        // Target modern JS — edge runtime supports ES2020+
                        ['@babel/preset-env', { targets: { esmodules: true } }],
                        ['@babel/react']
                    ]
                }
            },
            // Edge has no DOM — discard all CSS/SCSS (styles are delivered by
            // the client bundle through AEM ClientLibs as usual).
            {
                test: /\.(css|scss)$/,
                use: 'null-loader'
            }
        ]
    },

    plugins: [
        // Provide browser equivalents of Node globals used by bundled deps
        new webpack.ProvidePlugin({
            Buffer: ['buffer', 'Buffer'],
            process: 'process/browser'
        }),
        new webpack.EnvironmentPlugin({
            NODE_ENV: 'production',
            APP_ROOT_PATH: process.env.APP_ROOT_PATH || '/content/mysite/us/en'
        }),
        // Clean dist/edge/ before each build
        new CleanWebpackPlugin(['dist/edge']),
        // Single chunk — edge runtimes load one file
        new webpack.optimize.LimitChunkCountPlugin({ maxChunks: 1 })
    ]
};
