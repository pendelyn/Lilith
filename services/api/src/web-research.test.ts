import assert from "node:assert/strict";
import { test } from "node:test";
import { decideApproval, mockApprovalAction, researchAbortSignal, stopTask, createTaskStore } from "./tasks.ts";
import type { ApprovalRequest } from "@lilith/contracts";
import { PUBLIC_HTTPS_TIMEOUT_MS, type DnsAddress, type PublicHttpsGet } from "./ssrf.ts";
import {
  DISCLOSURE_PROMPT,
  DISCLOSURE_USER_HEADER,
  DISCLOSURE_USER_VALUE,
  TEST_COLOR_FIXTURE_COMMIT,
  UNTRUSTED_PAGE_TEXT,
  WEB_RESEARCH_OFF_REPLY,
  colorFixtureUrls,
  colorsInText,
  formatColorCompareResult,
  hasMarkedUserData,
  invokeDataDisclosure,
  isDisclosurePrompt,
  isExactPinnedFixtureUrl,
  needsDisclosureConsent,
  offlineWebResearchDeps,
  parsePublicReadPrompt,
  readColorFixtureFile,
  readPublicHttps,
  runColorCompare,
  runDisclosureResearch,
  runPublicPageRead,
  webResearchEnabled,
} from "./web-research.ts";

const owner = { ownerId: "alpha-owner" };

test("absent web research flag fails closed", () => {
  assert.equal(webResearchEnabled(true), true);
  assert.equal(webResearchEnabled(false), false);
  assert.equal(webResearchEnabled(undefined), false);
  assert.equal(WEB_RESEARCH_OFF_REPLY, "Web research is off.");
});

test("color fixtures compare to Blau and cite all three URLs", async () => {
  const net = countingNetwork();
  const urls = colorFixtureUrls(TEST_COLOR_FIXTURE_COMMIT);
  const run = await runColorCompare(createTaskStore(), owner, net.deps);
  assert.equal(run.result, formatColorCompareResult("Blau", urls));
  assert.match(run.result ?? "", /Blau/);
  assert.equal(run.result?.includes(urls.A), true);
  assert.equal(run.result?.includes(urls.B), true);
  assert.equal(run.result?.includes(urls.C), true);
  assert.deepEqual(run.cards.map((card) => card.state), ["waiting", "working", "completed"]);
  assert.equal(run.cards.every((card) => card.approval === undefined), true);
  assert.equal(net.lookups() > 0, true);
  assert.equal(net.connects(), 3);
  assert.equal(colorsInText(readColorFixtureFile("A")).includes("Blau"), true);
  assert.equal(isExactPinnedFixtureUrl(urls.A, TEST_COLOR_FIXTURE_COMMIT), true);
  assert.equal(needsDisclosureConsent({ url: urls.A }, TEST_COLOR_FIXTURE_COMMIT), false);
});

test("public reader fetches an arbitrary public URL, not only the color fixtures", async () => {
  const url = "https://example.com/notes";
  const net = countingNetwork({ [url]: "hello from the public web" });
  const page = await readPublicHttps({ url }, net.deps);
  assert.match(page.text, /hello from the public web/);
  assert.equal(net.connects(), 1);
  assert.equal(net.lookups(), 1);
});

test("untrusted page text cannot enable tools, open extra URLs, or look like a remember command we execute", async () => {
  const urls = colorFixtureUrls(TEST_COLOR_FIXTURE_COMMIT);
  const requested: string[] = [];
  const deps = offlineWebResearchDeps({
    get: async (input) => {
      requested.push(input.url.href);
      return {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
        body: `${UNTRUSTED_PAGE_TEXT}\nFarben: Rot, Blau`,
      };
    },
  });
  const page = await readPublicHttps({ url: urls.A }, deps);
  assert.equal(page.text.includes("Merk dir:"), true);
  assert.equal(requested.length, 1);
  assert.equal(requested[0], urls.A);
  assert.equal(hasMarkedUserData(undefined), false);
  assert.equal(parsePublicReadPrompt(`Lies ${urls.A}`), urls.A);
  assert.equal(parsePublicReadPrompt("Lies https://example.com/a https://169.254.169.254/"), undefined);
});

test("SSRF destinations and mixed DNS never connect; redirects are rejected", async () => {
  let connects = 0;
  const connect = () => {
    connects += 1;
  };
  const deps = offlineWebResearchDeps({ connect });
  for (const url of [
    "http://127.0.0.1/",
    "https://127.0.0.1/",
    "https://[::1]/",
    "https://10.0.0.1/",
    "https://192.168.1.1/",
    "https://169.254.169.254/",
    "https://metadata.google.internal/",
    "https://metadata.google.internal./",
    "https://localhost./",
    "https://[::ffff:127.0.0.1]/",
    "https://[::127.0.0.1]/",
    "https://[::7f00:1]/",
    "https://[::a00:1]/",
    "https://168.63.129.16/",
    "https://[fc00::1]/",
    "https://[fe80::1]/",
    "https://[2001:2::1]/",
    "https://[3fff::1]/",
    "https://[3ffe::1]/",
    "https://[5f00::1]/",
    "https://100.64.0.1/",
  ]) {
    await assert.rejects(readPublicHttps({ url }, deps), /Blocked destination|User data/);
  }
  await assert.rejects(
    readPublicHttps(
      { url: "https://example.com/" },
      {
        ...deps,
        lookupAll: async () => [
          { address: "8.8.8.8", family: 4 },
          { address: "10.0.0.1", family: 4 },
        ],
      },
    ),
    /Mixed DNS/,
  );
  await assert.rejects(
    readPublicHttps(
      { url: "https://example.com/" },
      {
        ...deps,
        get: async () => {
          connects += 1;
          return {
            status: 302,
            headers: { location: "https://127.0.0.1/", "content-type": "text/plain" },
            body: "",
          };
        },
      },
    ),
    /Redirect rejected/,
  );
  assert.equal(connects, 1);
});

test("3ffe destinations never connect", async () => {
  let lookups = 0;
  let connects = 0;
  const deps = offlineWebResearchDeps({
    lookupAll: async () => {
      lookups += 1;
      return [{ address: "1.1.1.1", family: 4 }];
    },
    connect: () => {
      connects += 1;
    },
  });
  for (const url of ["https://[3ffe::1]/", "https://[3ffe:831f::1]/", "https://[2d00::1]/"]) {
    await assert.rejects(readPublicHttps({ url }, deps), /Blocked destination/);
  }
  await assert.rejects(
    readPublicHttps(
      { url: "https://example.com/" },
      {
        ...deps,
        lookupAll: async () => {
          lookups += 1;
          return [{ address: "3ffe::1", family: 6 }];
        },
      },
    ),
    /Blocked destination/,
  );
  assert.equal(lookups, 1);
  assert.equal(connects, 0);
});

test("hung DNS times out and a late answer never connects", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let connects = 0;
  let finish!: (value: DnsAddress[]) => void;
  const get: PublicHttpsGet = async () => {
    connects += 1;
    return { status: 200, headers: { "content-type": "text/plain" }, body: "nope" };
  };
  const pending = readPublicHttps(
    { url: "https://example.com/" },
    {
      lookupAll: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      get,
    },
  );
  t.mock.timers.tick(PUBLIC_HTTPS_TIMEOUT_MS);
  await assert.rejects(pending, /timed out/);
  finish([{ address: "1.1.1.1", family: 4 }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connects, 0);
});

test("abort during DNS never starts an HTTPS request", async () => {
  const controller = new AbortController();
  let connects = 0;
  let finish!: (value: DnsAddress[]) => void;
  const get: PublicHttpsGet = async () => {
    connects += 1;
    return { status: 200, headers: { "content-type": "text/plain" }, body: "nope" };
  };
  const pending = readPublicHttps(
    { url: "https://example.com/" },
    {
      lookupAll: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      get,
      signal: controller.signal,
    },
  );
  await Promise.resolve();
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  finish([{ address: "1.1.1.1", family: 4 }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connects, 0);

  await assert.rejects(
    readPublicHttps(
      { url: "https://example.com/" },
      { lookupAll: async () => [{ address: "1.1.1.1", family: 4 }], get, signal: AbortSignal.abort() },
    ),
    /cancelled/,
  );
  assert.equal(connects, 0);
});

test("marked user data does not touch the network until bound consent; reject stale replay stay at zero", async () => {
  const store = createTaskStore();
  const deps = offlineWebResearchDeps();
  let fetches = 0;
  const counting = offlineWebResearchDeps({
    get: async (input) => {
      fetches += 1;
      assert.equal(input.headers[DISCLOSURE_USER_HEADER], DISCLOSURE_USER_VALUE);
      assert.equal(input.url.search, "");
      return {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
        body: readColorFixtureFile("A"),
      };
    },
  });
  await assert.rejects(
    readPublicHttps({
      url: colorFixtureUrls(TEST_COLOR_FIXTURE_COMMIT).A,
      userData: { headers: { [DISCLOSURE_USER_HEADER]: DISCLOSURE_USER_VALUE } },
    }, counting),
    /requires approval/,
  );
  assert.equal(fetches, 0);

  const preview = runDisclosureResearch(store, owner, counting);
  const approval = preview.cards[0]?.approval;
  assert.ok(approval);
  assert.equal(approval.actionClass, "data_disclosure");
  assert.equal(approval.origin, "https://raw.githubusercontent.com");
  assert.equal(fetches, 0);
  assert.equal(isDisclosurePrompt(DISCLOSURE_PROMPT), true);

  const rejected = await decideApproval(
    store,
    owner,
    approval.taskId,
    { approval, consent: false },
    {
      actionId: approval.actionId,
      actionClass: approval.actionClass,
      origin: approval.origin,
      operation: approval.operation,
      payload: approval.payload,
      files: approval.files,
      maxCostCents: approval.maxCostCents,
    },
    (action, key) => invokeDataDisclosure(action, key, counting),
  );
  assert.equal(fetches, 0);
  assert.match(rejected.result ?? "", /No call/);

  const store2 = createTaskStore();
  const second = runDisclosureResearch(store2, owner, counting).cards[0]?.approval;
  assert.ok(second);
  const actual = {
    actionId: second.actionId,
    actionClass: second.actionClass,
    origin: second.origin,
    operation: second.operation,
    payload: second.payload,
    files: second.files,
    maxCostCents: second.maxCostCents,
  };
  const approved = await decideApproval(
    store2,
    owner,
    second.taskId,
    { approval: second, consent: true },
    actual,
    (action, key) => invokeDataDisclosure(action, key, counting),
  );
  assert.equal(fetches, 1);
  assert.match(approved.result ?? "", /Testquelle A/);
  await assert.rejects(
    decideApproval(store2, owner, second.taskId, { approval: second, consent: true }, actual, () => {
      fetches += 1;
      return "replay";
    }),
  );
  assert.equal(fetches, 1);

  const staleNow = { now: 0 };
  const stale = createTaskStore({ now: () => staleNow.now });
  const pending = runDisclosureResearch(stale, owner, counting).cards[0]?.approval;
  assert.ok(pending);
  staleNow.now = 5 * 60_000;
  await assert.rejects(
    decideApproval(
      stale,
      owner,
      pending.taskId,
      { approval: pending, consent: true },
      {
        actionId: pending.actionId,
        actionClass: pending.actionClass,
        origin: pending.origin,
        operation: pending.operation,
        payload: pending.payload,
        files: pending.files,
        maxCostCents: pending.maxCostCents,
      },
      () => {
        fetches += 1;
        return "late";
      },
    ),
    /expired/,
  );
  assert.equal(fetches, 1);
});

test("stop between GETs prevents later fetches", async () => {
  const store = createTaskStore();
  let fetches = 0;
  const urls = colorFixtureUrls(TEST_COLOR_FIXTURE_COMMIT);
  const deps = offlineWebResearchDeps({
    get: async (input) => {
      fetches += 1;
      if (fetches === 1) {
        const child = [...store.tasks.values()].find((task) => task.role === "research");
        if (child !== undefined) stopTask(store, owner, child.id);
      }
      return {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
        body: input.url.href === urls.A ? readColorFixtureFile("A") : readColorFixtureFile("B"),
      };
    },
  });
  const run = await runColorCompare(store, owner, deps);
  assert.equal(run.result, undefined);
  assert.equal(fetches, 1);
  assert.equal(run.cards.some((card) => card.result?.includes("Blau")), false);
});

test("stop aborts the in-flight GET rather than waiting for it to finish", async () => {
  const store = createTaskStore();
  let aborted = false;
  let finished = false;
  const deps = offlineWebResearchDeps({
    get: async (input) => {
      const child = [...store.tasks.values()].find((task) => task.role === "research");
      if (child !== undefined) {
        assert.equal(input.signal?.aborted, false);
        assert.equal(researchAbortSignal(store, child.id), input.signal);
        stopTask(store, owner, child.id);
      }
      assert.equal(input.signal?.aborted, true);
      aborted = true;
      throw new Error("Web research cancelled");
    },
  });
  const run = await runColorCompare(store, owner, deps);
  finished = true;
  assert.equal(aborted, true);
  assert.equal(finished, true);
  assert.equal(run.result, undefined);
  assert.equal(run.cards.some((card) => card.result?.includes("Blau")), false);
});

test("Lies URL does not attach memories or extra user data; marked userData still gates", async () => {
  const url = "https://example.com/page?q=from-user";
  let seenMethod = "";
  let seenHref = "";
  let seenBody: string | undefined;
  let seenHeaders: Record<string, string> = {};
  let fetches = 0;
  const deps = offlineWebResearchDeps({
    get: async (input) => {
      fetches += 1;
      seenMethod = input.method;
      seenHref = input.url.href;
      seenBody = input.body;
      seenHeaders = input.headers;
      return {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
        body: "public",
      };
    },
  });
  const page = await readPublicHttps({ url }, deps);
  assert.equal(page.text, "public");
  assert.equal(seenHref, url);
  assert.equal(seenMethod, "GET");
  assert.equal(seenBody, undefined);
  assert.equal(seenHeaders["x-lilith-user-data"], undefined);
  const preview = await runPublicPageRead(createTaskStore(), owner, url, deps);
  assert.equal(preview.cards[0]?.approval?.state, "pending");
  assert.equal(fetches, 1);
  await assert.rejects(
    readPublicHttps({ url, userData: { query: "Antwortsprache Deutsch" } }, deps),
    /requires approval/,
  );
  await assert.rejects(
    readPublicHttps({ url, userData: { body: "chat-note" } }, deps),
    /requires approval/,
  );
  await assert.rejects(
    readPublicHttps({ url, userData: { headers: { [DISCLOSURE_USER_HEADER]: DISCLOSURE_USER_VALUE } } }, deps),
    /requires approval/,
  );
  assert.equal(fetches, 1);
});

test("arbitrary user HTTPS URLs wait for bound consent before DNS or HTTPS", async () => {
  const urls = colorFixtureUrls(TEST_COLOR_FIXTURE_COMMIT);
  const userUrl = "https://example.com/notes?q=from-user";
  const rootUrl = "https://example.com/";
  const encodedUrl = "https://EXAMPLE.COM/notes?q=from-user";
  const pages = {
    [userUrl]: "hello from the public web",
    [rootUrl]: "root page",
    [urls.A]: readColorFixtureFile("A"),
  };
  const net = countingNetwork(pages);

  const exact = await runPublicPageRead(createTaskStore(), owner, urls.A, net.deps);
  assert.match(exact.result ?? "", /Testquelle A/);
  assert.equal(exact.cards[0]?.approval, undefined);
  const afterFixture = { lookups: net.lookups(), connects: net.connects() };
  assert.equal(afterFixture.lookups > 0, true);
  assert.equal(afterFixture.connects, 1);

  for (const url of [
    userUrl,
    rootUrl,
    encodedUrl,
    `${urls.A}?q=secret`,
    `${urls.A}/extra`,
    "https://example.net/path",
  ]) {
    const preview = await runPublicPageRead(createTaskStore(), owner, url, net.deps);
    const approval = preview.cards[0]?.approval;
    assert.ok(approval, url);
    assert.equal(approval.actionClass, "data_disclosure");
    assert.equal(preview.result, undefined);
    assert.equal(net.lookups(), afterFixture.lookups, url);
    assert.equal(net.connects(), afterFixture.connects, url);
    const bound = JSON.parse(approval.payload) as { url: string };
    assert.equal(bound.url, new URL(url).href);
    assert.match(approval.operation, /^GET /);
    assert.match(approval.payload, /https:\/\//);
    assert.equal(needsDisclosureConsent({ url }, TEST_COLOR_FIXTURE_COMMIT), true);
  }

  const rejectStore = createTaskStore();
  const rejectPreview = await runPublicPageRead(rejectStore, owner, userUrl, net.deps);
  const rejectedApproval = rejectPreview.cards[0]?.approval;
  assert.ok(rejectedApproval);
  const rejected = await decideApproval(
    rejectStore,
    owner,
    rejectedApproval.taskId,
    { approval: rejectedApproval, consent: false },
    boundAction(rejectedApproval),
    (action, key) => invokeDataDisclosure(action, key, net.deps),
  );
  assert.match(rejected.result ?? "", /No call/);
  assert.equal(net.lookups(), afterFixture.lookups);
  assert.equal(net.connects(), afterFixture.connects);

  const approveStore = createTaskStore();
  const approvePreview = await runPublicPageRead(approveStore, owner, userUrl, net.deps);
  const approvedBinding = approvePreview.cards[0]?.approval;
  assert.ok(approvedBinding);
  assert.equal(approvedBinding.origin, "https://example.com");
  assert.equal(approvedBinding.operation, "GET /notes?q=from-user");
  const actual = boundAction(approvedBinding);
  const approved = await decideApproval(
    approveStore,
    owner,
    approvedBinding.taskId,
    { approval: approvedBinding, consent: true },
    actual,
    (action, key) => invokeDataDisclosure(action, key, net.deps),
  );
  assert.equal(net.lookups(), afterFixture.lookups + 1);
  assert.equal(net.connects(), afterFixture.connects + 1);
  assert.match(approved.result ?? "", /hello from the public web/);
  await assert.rejects(
    decideApproval(approveStore, owner, approvedBinding.taskId, { approval: approvedBinding, consent: true }, actual, () => "replay"),
  );
  assert.equal(net.lookups(), afterFixture.lookups + 1);
  assert.equal(net.connects(), afterFixture.connects + 1);

  const mismatchStore = createTaskStore();
  const mismatchPreview = await runPublicPageRead(mismatchStore, owner, userUrl, net.deps);
  const mismatch = mismatchPreview.cards[0]?.approval;
  assert.ok(mismatch);
  await assert.rejects(
    decideApproval(
      mismatchStore,
      owner,
      mismatch.taskId,
      { approval: mismatch, consent: true },
      { ...boundAction(mismatch), payload: JSON.stringify({ url: "https://example.com/other" }) },
      (action, key) => invokeDataDisclosure(action, key, net.deps),
    ),
    /changed/,
  );
  assert.equal(net.lookups(), afterFixture.lookups + 1);
  assert.equal(net.connects(), afterFixture.connects + 1);

  const stopStore = createTaskStore();
  const stopPreview = await runPublicPageRead(stopStore, owner, userUrl, net.deps);
  const pendingStop = stopPreview.cards[0]?.approval;
  assert.ok(pendingStop);
  stopTask(stopStore, owner, pendingStop.taskId);
  await assert.rejects(
    decideApproval(
      stopStore,
      owner,
      pendingStop.taskId,
      { approval: pendingStop, consent: true },
      boundAction(pendingStop),
      (action, key) => invokeDataDisclosure(action, key, net.deps),
    ),
  );
  assert.equal(net.lookups(), afterFixture.lookups + 1);
  assert.equal(net.connects(), afterFixture.connects + 1);

  let ssrfLookups = 0;
  let ssrfConnects = 0;
  const ssrf = offlineWebResearchDeps({
    lookupAll: async () => {
      ssrfLookups += 1;
      return [
        { address: "8.8.8.8", family: 4 },
        { address: "10.0.0.1", family: 4 },
      ];
    },
    connect: () => {
      ssrfConnects += 1;
    },
  });
  const ssrfStore = createTaskStore();
  const ssrfPreview = await runPublicPageRead(ssrfStore, owner, userUrl, ssrf);
  const ssrfApproval = ssrfPreview.cards[0]?.approval;
  assert.ok(ssrfApproval);
  assert.equal(ssrfLookups, 0);
  assert.equal(ssrfConnects, 0);
  await assert.rejects(
    decideApproval(
      ssrfStore,
      owner,
      ssrfApproval.taskId,
      { approval: ssrfApproval, consent: true },
      boundAction(ssrfApproval),
      (action, key) => invokeDataDisclosure(action, key, ssrf),
    ),
    /Mixed DNS/,
  );
  assert.equal(ssrfLookups, 1);
  assert.equal(ssrfConnects, 0);
});

test("mock write action class is unchanged by disclosure helpers", () => {
  const mock = mockApprovalAction();
  assert.equal(mock.actionClass, "external_effect");
  assert.equal(hasMarkedUserData({ query: "secret" }), true);
  assert.equal(hasMarkedUserData({ body: "secret" }), true);
  assert.equal(hasMarkedUserData({ headers: { [DISCLOSURE_USER_HEADER]: "x" } }), true);
});

function boundAction(approval: ApprovalRequest) {
  return {
    actionId: approval.actionId,
    actionClass: approval.actionClass,
    origin: approval.origin,
    operation: approval.operation,
    payload: approval.payload,
    files: approval.files,
    maxCostCents: approval.maxCostCents,
  };
}

function countingNetwork(pages?: Record<string, string>) {
  let lookups = 0;
  let connects = 0;
  return {
    lookups: () => lookups,
    connects: () => connects,
    deps: offlineWebResearchDeps({
      pages,
      lookupAll: async () => {
        lookups += 1;
        return [{ address: "1.1.1.1", family: 4 }];
      },
      connect: () => {
        connects += 1;
      },
    }),
  };
}
