const QueryEngine = require('@comunica/query-sparql-cottas').QueryEngine;
module.exports = require('./sparql-engine-base.js')(new QueryEngine());
