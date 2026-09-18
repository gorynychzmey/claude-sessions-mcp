#!/usr/bin/env node
// Cut a release: verify the tree, run the checks, bump package.json, commit and tag.
//
//   npm run release -- patch | minor | major | X.Y.Z
//
// Pushing is left to you — the script prints the command. Nothing here talks
// to a registry or a deploy pipeline; the tag is a marker, not a trigger.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const RELEASE_BRANCH = "master";

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function run(command, args) {
  execFileSync(command, args, { stdio: "inherit" });
}

function die(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

const bump = process.argv[2];
if (!bump) die("usage: npm run release -- patch|minor|major|X.Y.Z");
if (!/^(patch|minor|major|\d+\.\d+\.\d+)$/.test(bump)) {
  die(`"${bump}" is not patch, minor, major or an X.Y.Z version`);
}

const branch = git("rev-parse", "--abbrev-ref", "HEAD");
if (branch !== RELEASE_BRANCH) die(`on branch ${branch}; releases are cut from ${RELEASE_BRANCH}`);

if (git("status", "--porcelain") !== "") {
  die("the working tree has changes; commit or stash them first");
}

// The version a release moves to has to be free. npm version would refuse too,
// but late and less clearly.
const current = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
if (/^\d+\.\d+\.\d+$/.test(bump)) {
  if (git("tag", "--list", `v${bump}`) !== "") die(`tag v${bump} already exists`);
  if (bump === current) die(`package.json is already at ${bump}`);
}

// What the remote holds matters: a tag on a commit nobody else has is a tag
// that means something different to everyone else.
try {
  execFileSync("git", ["fetch", "--quiet", "origin", RELEASE_BRANCH], { stdio: "ignore" });
  const behind = git("rev-list", "--count", `HEAD..origin/${RELEASE_BRANCH}`);
  if (behind !== "0") die(`origin/${RELEASE_BRANCH} is ${behind} commit(s) ahead; pull first`);
} catch {
  console.warn("release: could not reach origin — releasing against the local branch only");
}

console.log(`release: ${current} -> ${bump}`);
run("npm", ["run", "build"]);
run("npx", ["vitest", "run"]);

// npm version writes package.json and the lock file, commits both, and tags
// the commit vX.Y.Z (its default tag-version-prefix).
run("npm", ["version", bump, "--message", "chore: release %s"]);

const released = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
console.log(`\nreleased ${released}, tagged v${released}`);
console.log(`push it with:\n  git push && git push origin v${released}`);
