'use strict';

const fs = require('fs-extra');

const {Octokit} = require('@octokit/rest');
const {throttling} = require('@octokit/plugin-throttling');

class Pulls {
  constructor() {
    this.DIR = 'data/pull';
  }

  async update(octokit) {
    await fs.mkdirp(this.DIR);

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
        const file = `${this.DIR}/${pr.number}.json`;
        console.log(`Writing ${file} (${pr.html_url})`);
        await fs.writeJson(file, pr);
      }
    }
  }

  async* getAll() {
    const files = await fs.readdir(this.DIR);
    // Sort numerically
    files.sort((a, b) => parseInt(a) - parseInt(b));
    for (const file of files) {
      yield fs.readJson(`${this.DIR}/${file}`);
    }
  }
}

class Tags {
  constructor() {
    this.DIR = 'data/tag';
  }

  async update(octokit) {
    await fs.mkdirp(this.DIR);

    const options = octokit.repos.listTags.endpoint.merge({
      owner: 'web-platform-tests',
      repo: 'wpt',
      per_page: 100,
    });

    for await (const response of octokit.paginate.iterator(options)) {
      for (const tag of response.data) {
        if (!tag.name.startsWith('merge_pr_')) {
          continue;
        }
        const file = `${this.DIR}/${tag.name}.json`;
        console.log(`Writing ${file} (${tag.name})`);
        await fs.writeJson(file, tag);
      }
    }
  }

  async* getAll() {
    const files = await fs.readdir(this.DIR);
    files.sort();
    for (const file of files) {
      yield fs.readJson(`${this.DIR}/${file}`);
    }
  }
}

class Releases {
  constructor() {
    this.DIR = 'data/release';
  }

  async update(octokit) {
    await fs.mkdirp(this.DIR);

    const options = octokit.repos.listReleases.endpoint.merge({
      owner: 'web-platform-tests',
      repo: 'wpt',
      per_page: 100,
    });

    for await (const response of octokit.paginate.iterator(options)) {
      for (const release of response.data) {
        const file = `${this.DIR}/${release.id}.json`;
        console.log(`Writing ${file} (${release.html_url})`);
        await fs.writeJson(file, release);
      }
    }
  }

  async* getAll() {
    const files = await fs.readdir(this.DIR);
    // Sort numerically
    files.sort((a, b) => parseInt(a) - parseInt(b));
    for (const file of files) {
      yield fs.readJson(`${this.DIR}/${file}`);
    }
  }
}

class Data {
  constructor() {
    this.pulls = new Pulls();
    this.tags = new Tags();
    this.releases = new Releases();
  }

  async updateAll() {
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
        onAbuseLimit: (retryAfter, options) => {
          console.error('Abuse limit triggered, not retrying!');
        },
      },
    });

    await this.pulls.update(octokit);
    await this.tags.update(octokit);
    await this.releases.update(octokit);
  }
}

module.exports = new Data();
