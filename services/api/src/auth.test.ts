import assert from "node:assert/strict";
import { test } from "node:test";
import {
  authenticateOwner,
  OWNED_RESOURCE_KINDS,
  requireOwned,
  type OwnedResource,
} from "./auth.ts";

const config = { token: "secret-token", ownerId: "alpha-owner" };

test("authentication maps only the configured token to the alpha owner", () => {
  assert.deepEqual(authenticateOwner("Bearer secret-token", config), { ownerId: "alpha-owner" });
  assert.equal(authenticateOwner(undefined, config), null);
  assert.equal(authenticateOwner("Bearer wrong-token", config), null);
});

test("all alpha resources reject missing or foreign ownership", () => {
  const owner = { ownerId: "alpha-owner" };

  for (const kind of OWNED_RESOURCE_KINDS) {
    const resource: OwnedResource = { id: `${kind}-1`, kind, ownerId: owner.ownerId };
    assert.equal(requireOwned(resource, owner), resource);
    assert.throws(
      () => requireOwned({ ...resource, ownerId: "foreign-owner" }, owner),
      /access denied/,
    );
    const missingOwner = { id: resource.id, kind };
    assert.throws(() => requireOwned(missingOwner, owner), /access denied/);
  }
});
