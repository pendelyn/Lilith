import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import {
  PUBLIC_HTTPS_TIMEOUT_MS,
  addressInPinSet,
  assertAllowedContentType,
  isBlockedHostname,
  isPublicUnicastAddress,
  parsePublicHttpsUrl,
  pinnedHttpsGet,
  resolvePublicHttps,
  type DnsAddress,
  type HttpsRequestFn,
  type PublicHttpsGetInput,
} from "./ssrf.ts";

test("URL parser blocks non-https, credentials, and non-443 ports", () => {
  for (const raw of [
    "http://example.com/",
    "http://127.0.0.1/",
    "file:///etc/passwd",
    "data:text/plain,Blau",
    "javascript:alert(1)",
    "https://user:pass@example.com/",
    "https://example.com:8443/",
    "https://example.com:80/",
    "https://",
    "not-a-url",
  ]) {
    assert.throws(() => parsePublicHttpsUrl(raw), /Blocked destination/, raw);
  }
  const ok = parsePublicHttpsUrl("https://example.com:443/path");
  assert.equal(ok.protocol, "https:");
  assert.equal(ok.hostname, "example.com");
  assert.equal(ok.port, "");
});

test("literal IP tricks and reserved ranges are classified after parse", () => {
  const blocked = [
    "https://127.0.0.1/",
    "https://127.1/",
    "https://0x7f000001/",
    "https://2130706433/",
    "https://0177.0.0.1/",
    "https://0/",
    "https://10.0.0.1/",
    "https://192.168.1.1/",
    "https://172.16.0.1/",
    "https://169.254.1.1/",
    "https://169.254.169.254/",
    "https://100.64.0.1/",
    "https://192.0.2.1/",
    "https://198.51.100.1/",
    "https://203.0.113.1/",
    "https://224.0.0.1/",
    "https://255.255.255.255/",
    "https://168.63.129.16/",
    "https://[::1]/",
    "https://[::ffff:127.0.0.1]/",
    "https://[::ffff:7f00:1]/",
    "https://[::ffff:169.254.169.254]/",
    "https://[::ffff:a9fe:a9fe]/",
    "https://[::ffff:10.0.0.1]/",
    "https://[::ffff:168.63.129.16]/",
    "https://[fc00::1]/",
    "https://[fd00:ec2::254]/",
    "https://[fe80::1]/",
    "https://[64:ff9b::7f00:1]/",
    "https://[2002:7f00:1::]/",
    "https://[2001:db8::1]/",
    "https://[::127.0.0.1]/",
    "https://[::7f00:1]/",
    "https://[::a00:1]/",
    "https://[::808:808]/",
    "https://[2001:2::1]/",
    "https://[2001:3::1]/",
    "https://[2001:30::1]/",
    "https://[3fff::1]/",
    "https://[3ffe::1]/",
    "https://[3ffe:831f::1]/",
    "https://[2d00::1]/",
    "https://[2e00::1]/",
    "https://[3000::1]/",
    "https://[5f00::1]/",
    "https://[2002:808:808::]/",
    "https://[64:ff9b::808:808]/",
    "https://[::ffff:0:127.0.0.1]/",
  ];
  for (const raw of blocked) {
    assert.throws(() => parsePublicHttpsUrl(raw), /Blocked destination/, raw);
  }
  assert.equal(isPublicUnicastAddress("8.8.8.8"), true);
  assert.equal(isPublicUnicastAddress("::ffff:8.8.8.8"), true);
  assert.equal(isPublicUnicastAddress("2001:4860:4860::8888"), true);
  assert.equal(isPublicUnicastAddress("127.0.0.1"), false);
  assert.equal(isPublicUnicastAddress("::1"), false);
  assert.equal(isPublicUnicastAddress("::127.0.0.1"), false);
  assert.equal(isPublicUnicastAddress("::7f00:1"), false);
  assert.equal(isPublicUnicastAddress("168.63.129.16"), false);
  assert.equal(isPublicUnicastAddress("2001:2::1"), false);
  assert.equal(isPublicUnicastAddress("5f00::1"), false);
  assert.equal(isPublicUnicastAddress("3fff::1"), false);
  assert.equal(isPublicUnicastAddress("3ffe::1"), false);
  assert.equal(isPublicUnicastAddress("3ffe:831f::1"), false);
  assert.equal(isPublicUnicastAddress("2d00::1"), false);
  assert.equal(isPublicUnicastAddress("2e00::1"), false);
  assert.equal(isPublicUnicastAddress("3000::1"), false);
  assert.equal(isPublicUnicastAddress("2c00::1"), true);
});

test("metadata and localhost names are blocked before DNS", async () => {
  assert.equal(isBlockedHostname("metadata.google.internal"), true);
  assert.equal(isBlockedHostname("localhost"), true);
  assert.equal(isBlockedHostname("foo.localhost"), true);
  assert.equal(isBlockedHostname("localhost."), true);
  assert.equal(isBlockedHostname("metadata.google.internal."), true);
  let lookups = 0;
  const lookup = async () => {
    lookups += 1;
    return [{ address: "8.8.8.8" as const, family: 4 as const }];
  };
  for (const raw of [
    "https://metadata.google.internal/",
    "https://localhost/",
    "https://foo.localhost/",
    "https://localhost./",
    "https://metadata.google.internal./",
    "https://foo.localhost./",
    "https://127.0.0.1./",
    "https://[::127.0.0.1]/",
    "https://[::7f00:1]/",
    "https://[::a00:1]/",
    "https://168.63.129.16/",
    "https://[2001:2::1]/",
    "https://[3fff::1]/",
    "https://[3ffe::1]/",
    "https://[2d00::1]/",
    "https://[5f00::1]/",
  ]) {
    await assert.rejects(resolvePublicHttps(raw, lookup), /Blocked destination/, raw);
  }
  assert.equal(lookups, 0);
});

test("mixed DNS answers never connect and DNS rebinding pins the first public lookup", async () => {
  let connects = 0;
  await assert.rejects(
    resolvePublicHttps("https://example.com/", async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ]),
    /Mixed DNS answers/,
  );
  await assert.rejects(
    resolvePublicHttps("https://example.com/", async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ]),
    /Mixed DNS answers/,
  );
  await assert.rejects(
    resolvePublicHttps("https://example.com/", async () => [{ address: "127.0.0.1", family: 4 }]),
    /Blocked destination/,
  );
  assert.equal(connects, 0);

  let lookups = 0;
  const resolved = await resolvePublicHttps("https://example.com/page", async () => {
    lookups += 1;
    return lookups === 1
      ? [{ address: "1.1.1.1", family: 4 }]
      : [{ address: "127.0.0.1", family: 4 }];
  });
  assert.deepEqual(resolved.addresses, ["1.1.1.1"]);
  assert.equal(lookups, 1);
  assert.equal(addressInPinSet("1.1.1.1", resolved.addresses), true);
  assert.equal(addressInPinSet("::ffff:1.1.1.1", resolved.addresses), true);
  assert.equal(addressInPinSet("127.0.0.1", resolved.addresses), false);
});

test("content types fail closed outside the text allowlist", () => {
  assertAllowedContentType("text/plain; charset=utf-8");
  assertAllowedContentType("text/html");
  assertAllowedContentType("application/json; charset=UTF-8");
  assert.throws(() => assertAllowedContentType(undefined), /Blocked content type/);
  assert.throws(() => assertAllowedContentType("application/octet-stream"), /Blocked content type/);
  assert.throws(() => assertAllowedContentType("text/plain; charset=utf-16"), /Blocked content type/);
});

test("6bone 3ffe and adjacent IANA-reserved 2000::/3 literals never start DNS", async () => {
  let lookups = 0;
  const lookup = async (): Promise<DnsAddress[]> => {
    lookups += 1;
    return [{ address: "1.1.1.1", family: 4 }];
  };
  for (const raw of ["https://[3ffe::1]/", "https://[3ffe:831f::1]/", "https://[2d00::1]/", "https://[3000::1]/"]) {
    await assert.rejects(resolvePublicHttps(raw, lookup), /Blocked destination/, raw);
  }
  assert.equal(lookups, 0);
  await assert.rejects(
    resolvePublicHttps("https://example.com/", async () => [{ address: "3ffe::1", family: 6 }]),
    /Blocked destination/,
  );
});

test("hung DNS times out and a late answer does not resolve", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let lookups = 0;
  let finish!: (value: DnsAddress[]) => void;
  const pending = resolvePublicHttps("https://example.com/", () => {
    lookups += 1;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  t.mock.timers.tick(PUBLIC_HTTPS_TIMEOUT_MS);
  await assert.rejects(pending, /timed out/);
  assert.equal(lookups, 1);
  finish([{ address: "1.1.1.1", family: 4 }]);
  await new Promise((resolve) => setImmediate(resolve));
});

test("aborting DNS never returns a late answer", async () => {
  const controller = new AbortController();
  let lookups = 0;
  let finish!: (value: DnsAddress[]) => void;
  const pending = resolvePublicHttps(
    "https://example.com/",
    () => {
      lookups += 1;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    controller.signal,
  );
  await Promise.resolve();
  assert.equal(lookups, 1);
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  finish([{ address: "1.1.1.1", family: 4 }]);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(resolvePublicHttps("https://example.com/", lookupPublic, AbortSignal.abort()), /cancelled/);
});

function lookupPublic(): Promise<DnsAddress[]> {
  return Promise.resolve([{ address: "1.1.1.1", family: 4 }]);
}

test("HTTP request is not written until the connected socket matches the pin set", async () => {
  const mismatch: string[] = [];
  await assert.rejects(
    pinnedHttpsGet(pinInput(), scriptedRequest({ remote: "10.0.0.1", events: mismatch })),
    /Pinned address mismatch/,
  );
  assert.equal(mismatch.includes("write"), false);
  assert.equal(mismatch.includes("end"), false);
  assert.equal(mismatch.includes("destroyed"), true);

  const pinned: string[] = [];
  const result = await pinnedHttpsGet(pinInput(), scriptedRequest({ remote: "1.1.1.1", events: pinned }));
  assert.equal(result.status, 200);
  assert.equal(pinned.indexOf("write") > pinned.indexOf("socket"), true);
  assert.equal(pinned.indexOf("end") > pinned.indexOf("write"), true);
});

test("abort destroys an in-flight HTTPS request before writing it", { timeout: 5_000 }, async () => {
  const already: string[] = [];
  await assert.rejects(
    pinnedHttpsGet({ ...pinInput(), signal: AbortSignal.abort() }, scriptedRequest({ remote: "1.1.1.1", events: already })),
    /cancelled/,
  );
  assert.deepEqual(already, []);

  const events: string[] = [];
  const controller = new AbortController();
  const pending = pinnedHttpsGet(
    { ...pinInput(), signal: controller.signal },
    scriptedRequest({ remote: "1.1.1.1", events, connecting: true, emitConnect: false }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.includes("socket"), true);
  assert.equal(events.includes("end"), false);
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  assert.equal(events.includes("destroyed"), true);
  assert.equal(events.includes("write"), false);
  assert.equal(events.includes("end"), false);
});

function pinInput(): PublicHttpsGetInput {
  return {
    url: new URL("https://example.com/note"),
    hostname: "example.com",
    addresses: ["1.1.1.1"],
    method: "GET",
    headers: { "x-lilith-user-data": "secret" },
    body: "disclosure",
  };
}

function scriptedRequest(options: {
  remote: string;
  events: string[];
  connecting?: boolean;
  emitConnect?: boolean;
}): HttpsRequestFn {
  return ((_, callback) => {
    const req = new EventEmitter() as ReturnType<HttpsRequestFn>;
    const socket = new EventEmitter() as { remoteAddress?: string; connecting?: boolean } & EventEmitter;
    socket.remoteAddress = options.remote;
    socket.connecting = options.connecting === true;
    Object.assign(req, {
      socket,
      write() {
        options.events.push("write");
        return true;
      },
      end() {
        options.events.push("end");
        queueMicrotask(() => {
          const res = new EventEmitter() as Parameters<typeof callback>[0];
          Object.assign(res, {
            socket,
            statusCode: 200,
            headers: { "content-type": "text/plain; charset=utf-8" },
          });
          callback(res);
          queueMicrotask(() => res.emit("end"));
        });
        return req;
      },
      destroy() {
        options.events.push("destroyed");
      },
    });
    queueMicrotask(() => {
      options.events.push("socket");
      req.emit("socket", socket);
      if (socket.connecting === true && options.emitConnect !== false) {
        queueMicrotask(() => {
          socket.connecting = false;
          socket.emit("connect");
        });
      }
    });
    return req;
  }) as HttpsRequestFn;
}
