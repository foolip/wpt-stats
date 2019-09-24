'use strict';

const pulls = require('./lib/pulls.js');

pulls.updateAll().catch((reason) => {
    console.error(reason);
    process.exit(1);
});
