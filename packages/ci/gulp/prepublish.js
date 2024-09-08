import { task } from "gulp";
import { execa } from "execa";
import { temporaryFile } from "tempy";
import { rename, readFile } from "fs/promises";
import conventionalGithubReleaser from "conventional-github-releaser";
import conventionalChangelog from "conventional-changelog";
import createPreset from "conventional-changelog-conventionalcommits";
import { RestrictEmptyCommits } from "./RestrictEmptyCommits.js";
import { pipeline } from "stream/promises";
import { combineStreams } from "./combineStreams.js";
import { createReadStream, createWriteStream } from "fs";

const tagPrefix = "di-v";
const commitPath = ".";
const changeLogFile = "CHANGELOG.md";
// print output of commands into the terminal
const stdio = "inherit";
const commitsConfig = { path: commitPath, ignore: /^chore: release/ };

async function bumpVersion(preset) {
  const bumper = new RestrictEmptyCommits(process.cwd())
    .loadPreset(preset)
    .tag({
      prefix: tagPrefix,
    })
    .commits(commitsConfig);

  const recommendation = await bumper.bump();

  if (!recommendation.releaseType) {
    return null;
  }

  await execa("yarn", ["version", recommendation.releaseType], {
    stdio,
  });

  return await readFile("package.json", "utf8").then(
    (content) => content.version,
  );
}

async function changelog(preset, version) {
  const changelogStream = conventionalChangelog(
    {
      config: preset,
      tagPrefix,
    },
    undefined,
    commitsConfig,
  );

  const combinedStream = combineStreams(
    changelogStream,
    createReadStream(changeLogFile),
  );

  const tmp = temporaryFile();

  await pipeline(combinedStream, createWriteStream(tmp, { flags: "w" }));
  await rename(tmp, changeLogFile);

  return version;
}

async function commitTagPush(version) {
  const commitMsg = `chore: release ${version}`;
  await execa("git", ["add", "package.json", "CHANGELOG.md"], { stdio });
  await execa("git", ["commit", "--message", commitMsg], { stdio });
  await execa("git", ["tag", `${tagPrefix}${version}`], { stdio });
  await execa("git", ["push", "--follow-tags"], { stdio });
}

async function githubRelease(preset) {
  await new Promise((resolve, reject) => {
    conventionalGithubReleaser(
      { type: "oauth", token: process.env.GITHUB_TOKEN },
      { config: preset, tagPrefix },
      undefined,
      commitsConfig,
      (err, success) => {
        if (err) {
          reject(err);
        } else {
          resolve(success);
        }
      },
    );
  });
}

task("ci:prepublish", async () => {
  const preset = createPreset();
  const version = await bumpVersion(preset);

  if (version === null) {
    return;
  }

  await changelog(preset, version);
  await commitTagPush(version);
  await githubRelease(preset);
});
