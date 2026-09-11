import { createHash, timingSafeEqual } from "node:crypto";

export type OwnerContext = Readonly<{ ownerId: string }>;

export const OWNED_RESOURCE_KINDS = ["conversation", "task", "provider_connection", "memory"] as const;
export type OwnedResourceKind = (typeof OWNED_RESOURCE_KINDS)[number];
export type OwnedResource = {
  id: string;
  kind: OwnedResourceKind;
  ownerId: string;
};

export function authenticateOwner(
  header: string | undefined,
  config: { token: string; ownerId: string },
): OwnerContext | null {
  return config.ownerId !== "" && bearerMatches(header, config.token)
    ? { ownerId: config.ownerId }
    : null;
}

export function requireOwned<T>(resource: T, owner: OwnerContext): T {
  if (
    typeof resource !== "object" ||
    resource === null ||
    !("ownerId" in resource) ||
    resource.ownerId !== owner.ownerId
  ) {
    throw new Error("Resource access denied");
  }
  return resource;
}

function bearerMatches(header: string | undefined, expected: string): boolean {
  if (header === undefined) return false;
  const [scheme, provided, extra] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !provided || extra !== undefined) return false;
  const left = createHash("sha256").update(provided).digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right);
}
