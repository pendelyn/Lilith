export type HealthResponse = {
  status: "ok";
};

export function parseHealthResponse(value: unknown): HealthResponse {
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    "status" in value &&
    value.status === "ok"
  ) {
    return { status: "ok" };
  }
  throw new Error("Invalid HealthResponse");
}
