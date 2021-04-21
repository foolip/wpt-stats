'use strict';

const {pulls} = require('./lib/data.js');

const {Octokit} = require('@octokit/rest');

const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});

// https://github.com/octokit/rest.js/#pagination
function paginate(method, parameters) {
  const options = method.endpoint.merge(parameters);
  return octokit.paginate(options);
}

function isRecentlyPendingCheck(check, maxAge = 6*3600) {
  if (check.conclusion === null && check.started_at) {
    const started = Date.parse(check.started_at);
    const age = (Date.now() - started) / 1000;
    if (age < maxAge) {
      return true;
    }
  }
  return false;
}

async function checkChecksForRef(ref, context) {
  const checks = await paginate(octokit.checks.listForRef, {
    owner: 'web-platform-tests',
    repo: 'wpt',
    ref,
    per_page: 100,
  });

  for (const check of checks) {
    if (check.conclusion === 'success' || check.conclusion === 'neutral') {
      continue;
    }

    if (isRecentlyPendingCheck(check)) {
      continue;
    }

    console.log(`${check.conclusion}: ${check.details_url} (for ${context})`);
  }
}

// eslint-disable-next-line no-unused-vars
async function checkCommits(since) {
  const commits = await paginate(octokit.repos.listCommits, {
    owner: 'web-platform-tests',
    repo: 'wpt',
    since,
    per_page: 100,
  });

  console.log(`Found ${commits.length} commits since ${since}`);

  for (const commit of commits) {
    await checkChecksForRef(commit.sha, commit.html_url);
  }
}

async function checkPRs(since) {
  const prs = [];
  for await (const pr of pulls.getAll()) {
    if (pr.state !== 'open') {
      continue;
    }
    if (pr.labels.some((label) => label.name === 'do not merge yet')) {
      continue;
    }
    if (Date.parse(pr.updated_at) < Date.parse(since)) {
      continue;
    }
    prs.push(pr);
  }

  console.log(`Found ${prs.length} PRs updated since ${since}`);

  for (const pr of prs) {
    const commit = pr.head;
    await checkChecksForRef(commit.sha, pr.html_url);
  }
}

async function main() {
  const WEEK_MS = 7*24*3600*1000;
  const weekAgo = new Date(Date.now() - WEEK_MS).toISOString();
  // Get rid of milliseconds, GitHub doesn't support it.
  const since = weekAgo.replace(/\.[0-9]+Z/, 'Z');

  await checkCommits(since);
  await checkPRs(since);
}

main().catch((reason) => {
  console.error(reason);
  process.exit(1);
});
