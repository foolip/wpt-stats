'use strict';

const pulls = require('./lib/pulls.js');

const Octokit = require('@octokit/rest');

const octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN,
});

const repoOptions = { owner: 'web-platform-tests', repo: 'wpt' };

// merge_pr_* tags should exist since July 2017.
const TAGS_SINCE = ('2017-07-01T00:00Z');

async function main() {
    let prs = [];
    for await (const pr of pulls.getAll()) {
        // Skip PRs not targeting master.
        if (pr.base.ref !== 'master') {
            continue;
        }

        // Skip unmerged and old PRs
        if (!pr.merged_at || Date.parse(pr.merged_at) < Date.parse(TAGS_SINCE)) {
            continue;
        }

        prs.push(pr);
    }
    // Sort by merge date, most recent first.
    prs.sort((a, b) => Date.parse(b.merged_at) - Date.parse(a.merged_at));

    console.log(`Found ${prs.length} PRs merged since ${TAGS_SINCE}`);

    for await (const pr of prs) {
        const tag = `merge_pr_${pr.number}`;

        let release;
        try {
            release = (await octokit.repos.getReleaseByTag({
                ...repoOptions,
                tag
            })).data;
        } catch (e) {
            if (e.status !== 404) {
                throw e;
            }
            // no release, check if there's a tag
            try {
                await octokit.git.getRef({
                    ...repoOptions,
                    ref: `tags/${tag}`
                });
                // there is a tag, just no release
                console.log(`${tag}: no release`);
            } catch(e) {
                if (e.status !== 404) {
                    throw e;
                }
                console.log(`${tag}: no tag`);
            }
            continue;
        }

        const manifest = release.assets.find(asset => {
            return /^MANIFEST(-[0-9a-f]{40}).json.gz$/.test(asset.name);
        });

        if (!manifest) {
            console.log(`${tag}: no manifest`);
            continue;
        }

        // The (compressed) manifest should be >2MB.
        if (manifest.size < 2000000) {
            console.log(`${tag}: manifest too small (${manifest.size})`);
        }

        console.log(`${tag}: OK`);
    }
}

main().catch((reason) => {
    console.error(reason);
    process.exit(1);
});
