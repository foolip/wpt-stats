import {Octokit} from '@octokit/rest';
import {throttling} from '@octokit/plugin-throttling';

// Manifests are uploaded as artifacts for releases on GitHub, for tags named
// merge_pr_*. These releases are created when (right after) a PR is merged, but
// the process is fallible and tags/releases can be missing.
//
// In principle we need to check if tags/releases exist for all merged PRs ever,
// which requires iterating through all PRs. (Very old PRs are still open and
// could be merged, so this can't be limited to PRs created since some date.)
//
// However, the cost of doing these checks steadily increase with time, so
// instead the approach is to check the most recently updated PRs:
//
// - Iterate all pull requests by update date, most recently updated first.
// - Ignore PRs that aren't merged or not merged into master/main.
// - Ignore PRs that were merged before merge_pr_* tags were used.
// - Ignore PRs that are known to be missing the tag for a good reason.
// - Stop iterating when the update date is older than a cutoff date.
//
// For all PRs found, check if there's a release with manifests uploaded. To
// avoid 1 request per PR, first cache all releases created before the cutoff
// date, 100 per request. Most of the releases we need to verify will be in the
// cache.
//
// Since PRs might be updated while we're iterating them, it's probably possible
// for the GitHub API to miss some PRs entirely. The only protection against
// this is to run this script often, making it unlikely that the same PR will be
// missed every single time.

// merge_pr_* tags should exist since July 2017. (The setup was added in
// November 2017 (#8005) but tags and releases have been backfilled.)
const TAGS_SINCE = Date.parse('2017-07-01T00:00Z');

// This cutoff date is to avoid indefinite growth in time taken, and can be
// bumped when it is known that all PRs before it pass. Note that any PR merged
// before this could still be updated (by a comment) and be checked anyway.
const CHECK_SINCE = Date.parse('2022-09-01T00:00Z');

// Avoid checking PRs that were recently merged, as tags/releases are created in
// a CI job that takes time. Allow for 1 hour.
const CHECK_UNTIL = Date.now() - 3600_000;

// PRs in an unusual state which we should ignore:
const IGNORE_PULLS = new Set([
  10543, // https://github.com/web-platform-tests/wpt/issues/10572#issuecomment-383751931
  11452, // https://github.com/web-platform-tests/wpt/issues/10572#issuecomment-428366544
  14238, // Subset of https://github.com/web-platform-tests/wpt/pull/14264
  15503, // "Test dummy commit (was not actually merged)"
  17616, // https://github.com/web-platform-tests/wpt/pull/17616#issuecomment-535428900
  21727, // https://github.com/web-platform-tests/wpt/pull/21727#issuecomment-633961074
  21755, // No changes
  21779, // Dupe of https://github.com/web-platform-tests/wpt/pull/21780
  23367, // Dupe of https://github.com/web-platform-tests/wpt/pull/23366
  23862, // Dupe of https://github.com/web-platform-tests/wpt/pull/23863
  25576, // No changes
  29117, // No changes
  29233, // Dupe of https://github.com/web-platform-tests/wpt/pull/29221
  31577, // Dupe of https://github.com/web-platform-tests/wpt/pull/31575
  31797, // No changes
  33431, // No changes
  36028, // No changes
  36039, // No changes
]);

async function* iteratePulls(octokit) {
  for await (const response of octokit.paginate.iterator(
      octokit.rest.pulls.list,
      {
        owner: 'web-platform-tests',
        repo: 'wpt',
        state: 'all',
        sort: 'updated',
        direction: 'desc',
        per_page: 100,
      },
  )) {
    for (const pr of response.data) {
      yield pr;
    }
  }
}

async function getReleaseCache(octokit) {
  const cache = new Map();
  let stop = false;

  // This API does not allow for sorting. But the order seems to be release
  // creation date, newest first, which is exactly what we need.
  for await (const response of octokit.paginate.iterator(
      octokit.rest.repos.listReleases,
      {
        owner: 'web-platform-tests',
        repo: 'wpt',
        per_page: 100,
      },
  )) {
    for (const release of response.data) {
      if (release.draft) {
        continue;
      }
      cache.set(release.tag_name, release);
      if (Date.parse(release.created_at) < CHECK_SINCE) {
        // Stop making requests but cache all the releases we just fetched.
        stop = true;
      }
    }
    if (stop) {
      break;
    }
  }

  return cache;
}

async function getRelease(octokit, cache, tag) {
  const cached = cache.get(tag);
  if (cached) {
    return cached;
  }

  let response;
  try {
    response = await octokit.rest.repos.getReleaseByTag({
      owner: 'web-platform-tests',
      repo: 'wpt',
      tag,
    });
  } catch (error) {
    if (error.status === 404) {
      return undefined;
    }
    throw error;
  }
  return response.data;
}

function shouldSkipPull(pr) {
  // Ignore some PRs manually.
  if (IGNORE_PULLS.has(pr.number)) {
    return true;
  }

  // Skip PRs not targeting the default branch.
  if (pr.base.ref !== 'main' && pr.base.ref !== 'master') {
    return true;
  }

  // Skip unmerged PRs
  if (!pr.merged_at) {
    return true;
  }

  // Skip PRs merged before there were merge_pr_* tags/releases.
  if (Date.parse(pr.merged_at) < TAGS_SINCE) {
    return true;
  }

  return false;
}

function checkRelease(release) {
  const formats = new Set();
  const pattern = /^MANIFEST-([0-9a-f]{40}).json.(.*)$/;
  for (const asset of release.assets) {
    if (asset.state !== 'uploaded') {
      throw new Error(`asset in unexpected state (${asset.state})`);
    }
    const match = asset.name.match(pattern);
    if (match) {
      const ext = match[2];
      if (formats.has(ext)) {
        throw new Error(`multiple .${ext} manifests found`);
      }
      if (asset.size < 1600000) {
        throw new Error(`${asset.name} smaller than expected (${asset.size} < 1600000)`);
      }
      formats.add(ext);
    }
  }
  if (!formats.has('gz')) {
    throw new Error('no .gz manifest found');
  }
}

async function main() {
  const ThrottlingOctokit = Octokit.plugin(throttling);

  const octokit = new ThrottlingOctokit({
    auth: process.env.GITHUB_TOKEN,
    throttle: {
      onRateLimit: (retryAfter, options) => {
        console.log('');
        if (options.request.retryCount <= 2) {
          console.warn(`Rate limiting triggered, retrying after ${retryAfter} seconds!`);
          return true;
        } else {
          console.error(`Rate limiting triggered, not retrying again!`);
        }
      },
      onAbuseLimit: () => {
        console.error('Abuse limit triggered, not retrying!');
      },
    },
  });

  const cache = await getReleaseCache(octokit);

  let checkedReleases = 0;
  const errors = [];

  for await (const pr of iteratePulls(octokit)) {
    const updatedAt = Date.parse(pr.updated_at);
    if (isNaN(updatedAt)) {
      throw new Error(`${pr.html_url} has no update date`);
    }

    // Silently skip recently updated PRs.
    if (updatedAt >= CHECK_UNTIL) {
      continue;
    }

    // Stop when the cutoff date has been reached.
    if (updatedAt < CHECK_SINCE) {
      break;
    }

    if (shouldSkipPull(pr)) {
      continue;
    }

    const release = await getRelease(octokit, cache, `merge_pr_${pr.number}`);

    if (!release) {
      const message = `${pr.html_url}: release not found`;
      console.error(message);
      errors.push(message);
      continue;
    }

    try {
      checkRelease(release);
      console.info(`${release.html_url} OK`);
    } catch (error) {
      const message = `${release.html_url}: ${error.message}`;
      console.error(message);
      errors.push(message);
    }

    checkedReleases++;
  }

  console.info();
  const fmt = (v) => new Date(v).toISOString();
  console.info(`Checked ${checkedReleases} PRs updated between ${fmt(CHECK_SINCE)} and ${fmt(CHECK_UNTIL)}.`);
  if (errors.length) {
    console.info(`There were ${errors.length} error(s):`);
    for (const message of errors) {
      console.error(message);
    }
    process.exit(1);
  } else {
    console.info('There were no errors.');
  }
}

await main();
