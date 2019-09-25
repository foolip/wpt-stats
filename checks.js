'use strict';

const {pulls} = require('./lib/data.js');

// Time of https://github.com/web-platform-tests/wpt/issues/13818#issuecomment-436330922
const AZURE_PIPELINES_SINCE = '2018-11-06T17:07:56Z';

const Octokit = require('@octokit/rest');

const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});

// https://github.com/octokit/rest.js/#pagination
function paginate(method, parameters) {
  const options = method.endpoint.merge(parameters);
  return octokit.paginate(options);
}

function getChecksForRef(ref) {
  return paginate(octokit.checks.listForRef, {
    owner: 'web-platform-tests',
    repo: 'wpt',
    ref,
    per_page: 100,
  });
}

async function getStatusesForRef(ref) {
  const statuses = await paginate(octokit.repos.listStatusesForRef, {
    owner: 'web-platform-tests',
    repo: 'wpt',
    ref,
    per_page: 100,
  });

  // Statuses are in reverse chronological order, so filter out all but the
  // first for each unique context string.
  const seenContexts = new Set;
  return statuses.filter(status => {
    const context = status.context;
    if (seenContexts.has(context)) {
      return false;
    }
    seenContexts.add(context);
    return true;
  });
}

function isRecentlyPendingCheck(check, maxAge = 6*3600) {
  if (check.conclusion === null && check.updated_at) {
    const updated = Date.parse(check.updated_at);
    const age = (Date.now() - updated) / 1000;
    if (age < maxAge) {
      return true;
    }
  }
  return false;
}

function isRecentlyPendingStatus(status, maxAge = 2*3600) {
  if (status.state === 'pending' && status.updated_at) {
    const updated = Date.parse(status.updated_at);
    const age = (Date.now() - updated) / 1000;
    if (age < maxAge) {
      return true;
    }
  }
  return false;
}

async function checkMaster(since) {
  const commits = await paginate(octokit.repos.listCommits, {
    owner: 'web-platform-tests',
    repo: 'wpt',
    since,
    per_page: 100
  });

  console.log(`Found ${commits.length} commits since ${since}`);

  for (const commit of commits) {
    const checks = await getChecksForRef(commit.sha);
    for (const check of checks) {
      if (check.conclusion === 'success' || check.conclusion === 'neutral') {
        continue;
      }

      if (isRecentlyPendingCheck(check)) {
        continue;
      }

      console.log(`${check.conclusion}: ${check.details_url} (for ${commit.sha})`);
    }

    const statuses = await getStatusesForRef(commit.sha);
    const status = statuses.find(s => s.context === 'Taskcluster (push)');
    if (!status) {
      continue;
    }

    if (isRecentlyPendingStatus(status)) {
      continue;
    }

    if (status.state !== 'success') {
      console.log(`${status.state}: ${status.target_url} (for ${commit.sha})`);
    }
  }
}

async function checkPRs(since) {
  const prs = [];
  for await (const pr of pulls.getAll()) {
    if (pr.state === 'open' && Date.parse(pr.updated_at) > Date.parse(since)) {
      prs.push(pr);
    }
  }

  console.log(`Found ${prs.length} PRs updated since ${since}`);

  for (const pr of prs) {
    const commit = pr.head;

    const checks = await getChecksForRef(commit.sha);
    const apCheck = checks.find(check => check.name == 'Azure Pipelines');
    if (apCheck) {
      if (!isRecentlyPendingCheck(apCheck) && apCheck.status !== 'completed') {
        // Likely infra problem
        console.log(`#${pr.number}: ${apCheck.status}: ${apCheck.details_url}`);
      }
    } else {
        // If created before the cutoff time and there are no checks, that's
        // probably because the update was just a commment and no CI has run.
        if (Date.parse(pr.created_at) >= Date.parse(AZURE_PIPELINES_SINCE)) {
            console.log(`#${pr.number}: no Azure Pipelines check`);
        }
    }

    const statuses = await getStatusesForRef(commit.sha);
    const tcStatus = statuses.find(s => s.context === 'Taskcluster (pull_request)');
    if (tcStatus) {
      if (!isRecentlyPendingStatus(tcStatus) &&
          tcStatus.state !== 'success' && tcStatus.state !== 'failure') {
        // Likely infra problem
        console.log(`#${pr.number}: ${tcStatus.state}: ${tcStatus.target_url}`);
      }
    } else {
      console.log(`#${pr.number}: no Taskcluster status`);
    }
  }
}

async function main() {
  const WEEK_MS = 7*24*3600*1000;
  const weekAgo = new Date(Date.now() - WEEK_MS).toISOString();
  // Get rid of milliseconds, GitHub doesn't support it.
  const since = weekAgo.replace(/\.[0-9]+Z/, 'Z');

  //await checkMaster(since);
  await checkPRs(since);
}

main().catch((reason) => {
  console.error(reason);
  process.exit(1);
});
