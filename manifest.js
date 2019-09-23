const Octokit = require('@octokit/rest');

const octokit = new Octokit({
    auth: `token ${process.env.GITHUB_TOKEN}`
});

const repoOptions = { owner: 'web-platform-tests', repo: 'wpt' };

// merge_pr_* tags should exist since July 2017.
const SINCE = Date.parse('2017-07-01T00:00Z');

// gets all PRs with pagination
async function* getAllPullRequests(prOptions) {
    let page = 0;
    while (true) {
        const prs = (await octokit.pulls.list({
            ...repoOptions,
            ...prOptions,
            per_page: 100,
            page,
        })).data;
        if (prs.length === 0) {
            break;
        }
        console.log(`# page ${page}`);
        for (const pr of prs) {
            yield pr;
        }
        page++;
    }
}

async function main() {
    // Note: sorting by update time means the order can change, so with
    // pagination we may miss some PRs and see some twice. But the
    // alternative is to fetch every single PR, since old triple-digit
    // PRs can be merged at any time and should be tagged.
    const prs = getAllPullRequests({
        base: 'master',
        state: 'closed',
        sort: 'created',
        direction: 'asc',
    });

    for await (const pr of prs) {
        // Skip unmerged and old PRs
        if (!pr.merged_at || Date.parse(pr.merged_at) < SINCE) {
            continue;
        }

        const tag = `merge_pr_${pr.number}`;

        let release;
        try {
            release = (await octokit.repos.getReleaseByTag({
                ...repoOptions,
                tag
            })).data;
        } catch (e) {
            // no release, check if there's a tag
            try {
                await octokit.gitdata.getReference({
                    ...repoOptions,
                    ref: `tags/${tag}`
                });
                // there is a tag, just no release
                console.log(`${tag}: no release`);
            } catch(e) {
                console.log(`${tag}: no tag`);
            }
            continue;
        }

        const manifest = release.assets.find(asset => {
            return /^MANIFEST-[0-9a-f]{40}.json.gz$/.test(asset.name);
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

main();