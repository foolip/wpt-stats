'use strict';

const Octokit = require('@octokit/rest');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

if (!GITHUB_TOKEN) {
  console.error('Please set the GITHUB_TOKEN environment variable.');
  console.error('https://github.com/settings/tokens');
  process.exit(1);
}

const octokit = new Octokit({
  auth: GITHUB_TOKEN,
});

// Time of https://github.com/web-platform-tests/wpt/issues/13818#issuecomment-436330922
const SINCE = '2018-11-06T17:07:56Z';

async function paginate(method, parameters) {
  parameters = Object.assign({ per_page: 100 }, parameters);
  const options = method.endpoint.merge(parameters);
  return octokit.paginate(options);
}

async function main() {
  const prs = await paginate(octokit.search.issuesAndPullRequests, {
    q: `repo:web-platform-tests/wpt is:pr is:open updated:>${SINCE}`,
  });

  for (const pr of prs) {
    const commits = await paginate(octokit.pulls.listCommits, {
      owner: 'web-platform-tests',
      repo: 'wpt',
      pull_number: pr.number,
    });

    // only look at the final commit
    const ref = commits[commits.length - 1].sha;

    const checks = await paginate(octokit.checks.listForRef, {
      owner: 'web-platform-tests',
      repo: 'wpt',
      ref,
    });

    const azureRun = checks.find(run => run.name == 'Azure Pipelines');
    if (!azureRun) {
        // If created before the cutoff time and there are no checks, that's
        // probably because the update was just a commment and no CI has run.
        if (Date.parse(pr.created_at) < Date.parse(SINCE)) {
            continue;
        }
        // Otherwise there might be something wrong.
        console.log(`#${pr.number}: no check`);
        continue;
    }

    if (azureRun.status !== 'completed') {
      const msAgo = Date.now() - Date.parse(azureRun.started_at);
      const minAgo = Math.floor(msAgo / 60000);
      console.log(`#${pr.number}: ${azureRun.status} (started ${minAgo} min ago)`);
    } else {
      console.log(`#${pr.number}: ${azureRun.conclusion}`);
    }
  }
}

main().catch((reason) => {
  console.error(reason);
  process.exit(1);
});
