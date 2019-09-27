'use strict';

const {pulls, tags, releases} = require('./lib/data.js');

// merge_pr_* tags should exist since July 2017.
const TAGS_SINCE = ('2017-07-01T00:00Z');

// pull requests in an unusual state which we should ignore
const IGNORE_PULLS = new Set([
    10543, // https://github.com/web-platform-tests/wpt/issues/10572#issuecomment-383751931
    11452, // https://github.com/web-platform-tests/wpt/issues/10572#issuecomment-428366544
    14238, // Subset of https://github.com/web-platform-tests/wpt/pull/14264
    15503, // "Test dummy commit (was not actually merged)"
    17616, // https://github.com/web-platform-tests/wpt/pull/17616#issuecomment-535428900
]);

async function main() {
    const prs = [];
    for await (const pr of pulls.getAll()) {
        // Ignore some PRs manually.
        if (IGNORE_PULLS.has(pr.number)) {
            continue;
        }

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
    console.log(`Found ${prs.length} PRs`);

    // Map from tag name to commit.
    const commitMap = new Map();
    for await (const tag of tags.getAll()) {
        commitMap.set(tag.name, tag.commit.sha);
    }
    console.log(`Found ${commitMap.size} tags`);

    const releaseMap = new Map();
    for await (const release of releases.getAll()) {
        const tag = release.tag_name;
        if (!release.tag_name.startsWith('merge_pr_')) {
            console.warn(`${release.html_url} tag name is unexpected`);
            continue;
        }
        if (releaseMap.has(tag)) {
            console.warn(`${tag} has multiple releases`);
            continue;
        }
        releaseMap.set(tag, release);
    }
    console.log(`Found ${releaseMap.size} releases`);

    for (const pr of prs) {
        const tag = `merge_pr_${pr.number}`;

        const commit = commitMap.get(tag);
        if (!commit) {
            console.warn(`${pr.html_url} has no tag (${tag})`);
            continue;
        }

        const release = releaseMap.get(tag);
        if (!release) {
            console.warn(`${pr.html_url} has no release`);
            continue;
        }

        const formats = new Set();
        const pattern = /^MANIFEST-([0-9a-f]{40}).json.(.*)$/;
        for (const asset of release.assets) {
            if (asset.state !== 'uploaded') {
                console.warn(`${release.html_url} has assets in bad state`);
                continue;
            }
            const match = asset.name.match(pattern);
            if (match) {
                const assetCommit = match[1];
                if (assetCommit !== commit) {
                    console.warn(`${release.html_url} has asset ${asset.name} for wrong commit`);
                }
                const ext = match[2];
                if (formats.has(ext)) {
                    console.warn(`${release.html_url} has multiple MANIFEST.json.${ext}`);
                }
                if (asset.size < 1600000) {
                    console.warn(`${release.html_url}: MANIFEST.json.${ext} smaller than expected (${asset.size})`);
                }
                formats.add(ext);
            }
        }
        if (!formats.has('gz')) {
            console.warn(`${release.html_url} has no MANIFEST.json.gz`);
            continue;
        }
    }
}

main().catch((reason) => {
    console.error(reason);
    process.exit(1);
});
