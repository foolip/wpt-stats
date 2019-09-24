const fs = require('fs-extra');

const Octokit = require('@octokit/rest');

const PULL_DIR = 'data/pull';

async function updateAll() {
    const octokit = new Octokit({
        auth: process.env.GITHUB_TOKEN,
    });

    await fs.mkdirp(PULL_DIR);

    const options = octokit.pulls.list.endpoint.merge({
        owner: 'web-platform-tests',
        repo: 'wpt',
        state: 'all',
        sort: 'created',
        direction: 'asc',
        per_page: 100,
    });

    for await (const response of octokit.paginate.iterator(options)) {
        for (const pr of response.data) {
            const file = `${PULL_DIR}/${pr.number}.json`;
            console.log(`Writing ${file}`);
            await fs.writeJson(file, pr);
        }
    }
}

async function* getAll() {
    const files = await fs.readdir(PULL_DIR);
    // Sort numerically
    files.sort((a, b) => parseInt(a) - parseInt(b));
    for (const file of files) {
        yield fs.readJson(`${PULL_DIR}/${file}`);
    }
}

module.exports = { updateAll, getAll };
