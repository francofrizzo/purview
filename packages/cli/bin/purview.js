#!/usr/bin/env node
'use strict';

// This file has no build step and must stay parseable by whatever Node
// version happens to run it -- including ones far older than we support --
// so the version check below can print a friendly sentence instead of
// letting an old Node choke on syntax it doesn't understand partway through
// loading the real (modern) server. Keep this file plain: var, no optional
// chaining, no nullish coalescing, no arrow-function defaults that a really
// old engine might trip on.
//
// bin/package.json pins this file to CommonJS regardless of the package
// root's "type": "module", so plain require() works here even though
// everything else in this package is ESM.

var nodeVersion = process.versions.node;
var major = parseInt(nodeVersion.split('.')[0], 10);

if (!(major >= 20)) {
  console.error(
    'Purview needs Node 20 or newer; you are on v' + nodeVersion + '. ' +
      'Install a newer Node (nodejs.org, or nvm/fnm/volta) and try again.',
  );
  process.exit(1);
}

var path = require('path');
var pathToFileURL = require('url').pathToFileURL;

var serverEntry = path.join(__dirname, '..', 'dist', 'server.js');

// The bundled server entry is ESM, so it has to be loaded with a dynamic
// import() rather than require(); everything up to here is deliberately old
// enough syntax to run on Node < 20 so that branch is the one that prints,
// not a SyntaxError.
import(pathToFileURL(serverEntry).href).catch(function (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
