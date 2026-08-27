import assert from "node:assert/strict";
import { deployedBaseURL, deployedVersionId } from "../deploy-cloudflare.mjs";

const deployments = JSON.stringify([
  {
    created_on: "2026-08-27T00:01:00Z",
    versions: [{ version_id: "11111111-1111-4111-8111-111111111111", percentage: 100 }],
  },
  {
    created_on: "2026-08-27T07:18:00Z",
    versions: [
      { version_id: "33333333-3333-4333-8333-333333333333", percentage: 10 },
      { version_id: "22222222-2222-4222-8222-222222222222", percentage: 90 },
    ],
  },
]);

assert.equal(deployedVersionId(deployments), "22222222-2222-4222-8222-222222222222");
assert.equal(
  deployedBaseURL("Uploaded https://example-worker.example.workers.dev\n", ""),
  "https://example-worker.example.workers.dev",
);
assert.equal(deployedBaseURL("no public URL required", "api.example.com"), "https://api.example.com");

console.log("deployment helper checks passed");
