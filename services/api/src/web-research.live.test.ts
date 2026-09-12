import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COLOR_FIXTURE_COMMIT,
  colorFixtureUrls,
  invokeDataDisclosure,
  pinnedColorFixtureCommit,
  readPublicHttps,
  runColorCompare,
  runPublicPageRead,
} from "./web-research.ts";
import { createTaskStore, decideApproval } from "./tasks.ts";

const live = process.env.LILITH_LIVE_WEB_TESTS === "1";

test("live public HTTPS fixtures return Blau and cite the three pinned URLs", { skip: !live }, async () => {
  assert.equal(process.env.LILITH_COLOR_FIXTURE_COMMIT ?? "", "");
  assert.equal(COLOR_FIXTURE_COMMIT, "284f7f8a5fa74fbd7a0794b3be8e0352932dfe2a");
  const commit = pinnedColorFixtureCommit();
  assert.equal(commit, COLOR_FIXTURE_COMMIT);
  const urls = colorFixtureUrls(commit);
  const pages = await Promise.all([
    readPublicHttps({ url: urls.A }),
    readPublicHttps({ url: urls.B }),
    readPublicHttps({ url: urls.C }),
  ]);
  assert.match(pages[0]?.text ?? "", /Rot/);
  assert.match(pages[0]?.text ?? "", /Blau/);
  assert.match(pages[1]?.text ?? "", /Blau/);
  assert.match(pages[1]?.text ?? "", /Grün/);
  assert.match(pages[2]?.text ?? "", /Blau/);
  assert.match(pages[2]?.text ?? "", /Gelb/);
  const run = await runColorCompare(createTaskStore(), { ownerId: "alpha-owner" });
  assert.match(run.result ?? "", /Blau/);
  assert.equal(run.result?.includes(urls.A), true);
  assert.equal(run.result?.includes(urls.B), true);
  assert.equal(run.result?.includes(urls.C), true);
});

test("live public reader fetches an arbitrary HTTPS host, not a fixture allowlist", { skip: !live }, async () => {
  const page = await readPublicHttps({ url: "https://example.com/" });
  assert.match(page.text, /Example Domain/i);
  assert.match(page.url, /example\.com/);
});

test("live arbitrary HTTPS URL fetches only after disclosure consent", { skip: !live }, async () => {
  const store = createTaskStore();
  const owner = { ownerId: "alpha-owner" };
  const url = "https://example.com/";
  const preview = await runPublicPageRead(store, owner, url);
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
    (action, key) => invokeDataDisclosure(action, key),
  );
  assert.match(approved.result ?? "", /Example Domain/i);
});
