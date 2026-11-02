import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { readMeta, setGhAsyncRunner, setGhRunner } from "@reviewer/core";
import { createApp } from "../src/app.js";
import { buildFixture, key } from "./fixtures.js";

let root: string;
let app: ReturnType<typeof createApp>;
const url = `/api/prs/${encodeURIComponent(`${key.host}/${key.owner}/${key.repo}/${key.number}`)}`;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "purview-review-requests-"));
  buildFixture(root);
  setGhRunner(() => "{}");
  app = createApp({ stateDir: root, webDist: path.join(root, "no-web"), autoAnalyze: false });
});
afterEach(() => {
  setGhAsyncRunner(null);
  setGhRunner(null);
  fs.rmSync(root, { recursive: true, force: true });
});

const reviewStatus = (requested: string[]) =>
  JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          reviewRequests: { nodes: requested.map((login) => ({ requestedReviewer: { __typename: "User", login } })) },
          latestReviews: { nodes: [] },
        },
      },
    },
  });

it("requests a reviewer on GitHub and answers with the reviewers it now has", async () => {
  const calls: string[][] = [];
  setGhAsyncRunner(async (args) => {
    calls.push(args);
    return args.includes("graphql") ? reviewStatus(["dana"]) : "{}";
  });
  const res = await app.request(`${url}/reviewers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ users: ["dana"] }),
  });
  expect(res.status).toBe(200);
  expect((await res.json()).reviewers).toEqual([{ login: "dana", avatarUrl: null, kind: "user", state: "requested" }]);
  expect(calls[0]).toContain("POST");
  expect(readMeta(key, root).reviewers?.map((r) => r.login)).toEqual(["dana"]);
});

it("refuses a request that names nobody", async () => {
  const res = await app.request(`${url}/reviewers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ users: [] }),
  });
  expect(res.status).toBe(400);
});

it("says what GitHub refused", async () => {
  setGhAsyncRunner(async () => {
    throw new Error("gh: Reviews may only be requested from collaborators. (HTTP 422)");
  });
  const res = await app.request(`${url}/reviewers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ users: ["stranger"] }),
  });
  expect(res.status).toBeGreaterThanOrEqual(400);
  expect(JSON.stringify(await res.json())).toContain("collaborators");
});
