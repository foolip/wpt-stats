'use strict';

const octokit = require('@octokit/rest')();

const GH_TOKEN = process.env.GH_TOKEN;

if (!GH_TOKEN) {
  console.error('Please set the GH_TOKEN environment variable.');
  console.error('https://github.com/settings/tokens');
  process.exit(1);
}

octokit.authenticate({
  type: 'token',
  token: GH_TOKEN
});

// Time of https://github.com/web-platform-tests/wpt/issues/13818#issuecomment-436330922
const SINCE = '2018-11-06T17:07:56Z';

async function paginate(method, parameters) {
  parameters = Object.assign({ per_page: 100 }, parameters);
  let response = await method(parameters);
  const { data } = response;

  while (octokit.hasNextPage(response)) {
    response = await octokit.getNextPage(response);
    data.push(...response.data);
  }
  return data;
}

async function paginateSearch(method, parameters) {
  parameters = Object.assign({ per_page: 100 }, parameters);
  let response = await method(parameters);
  const items = response.data.items;

  while (octokit.hasNextPage(response)) {
    response = await octokit.getNextPage(response);
    items.push(...response.data.items);
  }
  return items;
}

(async () => {
  const prs = await paginateSearch(octokit.search.issues, {
    q: `repo:web-platform-tests/wpt is:pr is:open updated:>${SINCE}`,
  });

  for (const pr of prs) {
    console.log(octokit.pullRequests.getCommits);
    const commits = await paginate(octokit.pullRequests.getCommits, {
      owner: 'web-platform-tests',
      repo: 'wpt',
      number: pr.number,
    });

    // only look at the final commit
    const ref = commits[commits.length - 1].sha;

    const checks = await paginate(octokit.checks.listForRef, {
      owner: 'web-platform-tests',
      repo: 'wpt',
      ref,
    });

    const azureRun = checks.check_runs.find(run => run.name == 'Azure Pipelines');
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
})();
