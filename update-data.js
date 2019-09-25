'use strict';

const data = require('./lib/data.js');

data.updateAll().catch((reason) => {
    console.error(reason);
    process.exit(1);
});
