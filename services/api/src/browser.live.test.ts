import assert from "node:assert/strict";
import { test } from "node:test";
import { invokeBrowserOpen, runPublicBrowserOpen } from "./browser.ts";
import { decideApproval, createTaskStore } from "./tasks.ts";

const live = process.env.LILITH_LIVE_WEB_TESTS === "1" && process.env.RUN_DOCKER_TESTS === "1";
const owner = { ownerId: "alpha-owner" };

test("live Öffne example.com waits for consent then reads Example Domain via SSRF fulfill", { skip: !live, timeout: 180_000 }, async () => {
  const store = createTaskStore();
  const url = "https://example.com/";
  const preview = await runPublicBrowserOpen(store, owner, url);
  const approval = preview.cards[0]?.approval;
  assert.ok(approval);
  assert.equal(approval.actionClass, "data_disclosure");
  assert.equal(preview.result, undefined);
  const actual = {
    actionId: approval.actionId,
    actionClass: approval.actionClass,
    origin: approval.origin,
    operation: approval.operation,
    payload: approval.payload,
    files: approval.files,
    maxCostCents: approval.maxCostCents,
  };
  const approved = await decideApproval(
    store,
    owner,
    approval.taskId,
    { approval, consent: true },
    actual,
    (action, key) => invokeBrowserOpen(action, key, { store, owner, taskId: approval.taskId }),
  );
  assert.match(approved.result ?? "", /Example Domain/i);
});

test("live 169.254 is not fetched by the browser fulfill path", { skip: !live, timeout: 30_000 }, async () => {
  const run = await runPublicBrowserOpen(createTaskStore(), owner, "https://169.254.169.254/");
  assert.equal(run.result, undefined);
  assert.equal(run.cards.some((card) => card.approval !== undefined), false);
  assert.equal(run.cards.at(-1)?.state, "failed");
});
