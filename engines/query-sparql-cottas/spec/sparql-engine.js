const QueryEngine = require('@elias.crum/query-sparql-cottas').QueryEngine;
module.exports = require('./sparql-engine-base.js')(new QueryEngine());
