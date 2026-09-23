import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MASCOT_PIXELS,
  MASCOT_STATES,
  mascotPresentation,
  selectMascotState,
  type MascotCard,
  type MascotConnection,
  type MascotMessage,
} from "./mascot.ts";

function assistant(status: MascotMessage["status"], subagents?: readonly MascotCard[]): MascotMessage {
  return subagents === undefined ? { role: "assistant", status } : { role: "assistant", status, subagents };
}

function at(connection: MascotConnection, messages: readonly MascotMessage[]) {
  return selectMascotState({ connection, messages });
}

const user: MascotMessage = { role: "user", status: "sent" };

test("mascot state follows the latest reply, its cards, and connection faults", () => {
  assert.equal(at("idle", []), "idle");
  assert.equal(at("loading", []), "idle");
  assert.equal(at("success", [user]), "idle");

  assert.equal(at("streaming", []), "thinking");
  assert.equal(at("streaming", [assistant("streaming")]), "thinking");
  assert.equal(at("success", [assistant("streaming")]), "thinking");
  assert.equal(at("streaming", [assistant("complete")]), "thinking");

  assert.equal(at("streaming", [assistant("streaming", [{ state: "waiting" }])]), "delegating");
  assert.equal(at("success", [assistant("streaming", [{ state: "waiting", browser: undefined }])]), "delegating");

  assert.equal(at("streaming", [assistant("streaming", [{ state: "working" }])]), "working");
  assert.equal(
    at("streaming", [assistant("streaming", [{ state: "waiting", browser: { current: true } }])]),
    "working",
  );
  assert.equal(
    at("success", [
      assistant("streaming", [{ state: "waiting" }, { state: "working" }]),
    ]),
    "working",
  );

  assert.equal(at("success", [assistant("complete", [{ state: "needs_input" }])]), "waiting");
  assert.equal(at("success", [assistant("streaming", [{ state: "paused" }])]), "waiting");
  assert.equal(
    at("streaming", [assistant("streaming", [{ state: "working" }, { state: "needs_input" }])]),
    "waiting",
  );
  assert.equal(
    at("success", [assistant("complete", [{ state: "paused", browser: { current: true } }])]),
    "waiting",
  );

  assert.equal(at("success", [assistant("complete")]), "success");
  assert.equal(at("loading", [assistant("complete", [{ state: "completed" }])]), "success");
  assert.equal(at("success", [assistant("complete", [{ state: "stopped" }])]), "success");
  assert.equal(
    at("success", [assistant("complete", [{ state: "completed", browser: { current: true } }])]),
    "success",
  );
  assert.equal(at("success", [assistant("failed"), user, assistant("complete")]), "success");

  assert.equal(at("unauthorized", []), "error");
  assert.equal(at("unreachable", [assistant("complete")]), "error");
  assert.equal(at("unexpected", [assistant("streaming", [{ state: "working" }])]), "error");
  assert.equal(at("success", [assistant("failed")]), "error");
  assert.equal(at("success", [assistant("failed", [{ state: "working" }])]), "error");
  assert.equal(at("streaming", [assistant("streaming", [{ state: "failed" }])]), "error");
  assert.equal(
    at("success", [assistant("complete", [{ state: "failed" }, { state: "needs_input" }])]),
    "error",
  );
  assert.equal(at("success", [assistant("complete", [{ state: "failed" }]), assistant("streaming")]), "thinking");
});

test("reduced motion keeps every pose static and the seven cats distinct", () => {
  const poses = MASCOT_STATES.map((state) => mascotPresentation(state, true));
  const joined = new Set(poses.map((pose) => pose.rows.join("\n")));
  assert.equal(joined.size, MASCOT_STATES.length);

  const pixels = new Set<string>([".", ...Object.keys(MASCOT_PIXELS)]);
  for (const state of MASCOT_STATES) {
    const reduced = mascotPresentation(state, true);
    const full = mascotPresentation(state, false);
    assert.equal(reduced.animate, false);
    assert.equal(full.animate, false);
    assert.deepEqual(reduced.rows, full.rows);
    assert.equal(reduced.rows.length, 10);
    assert.equal(reduced.rows[8], "o..oo.......");
    assert.equal(reduced.rows[9], ".oooo.......");
    for (const row of reduced.rows) {
      assert.equal(row.length, 12);
      for (const pixel of row) assert.ok(pixels.has(pixel), pixel);
    }
    const art = reduced.rows.join("");
    assert.ok(art.includes("o") && art.includes("f"));
  }

  const art = (state: (typeof MASCOT_STATES)[number]) => mascotPresentation(state, true).rows.join("");
  assert.ok(art("idle").includes("e"));
  assert.ok(art("thinking").includes("e"));
  assert.ok(art("delegating").includes("ooffffffooo."));
  assert.ok(art("working").includes("e"));
  assert.equal(art("waiting").includes("e"), false);
  assert.ok(art("success").includes("s"));
  assert.ok(art("error").includes("r"));
});

test("thinking and working differ from idle in bright outline cells", () => {
  const rows = (state: "idle" | "thinking" | "working") => mascotPresentation(state, true).rows;
  const outline = (row: string) => row.replace(/[^o]/g, ".");
  const idle = rows("idle");
  const thinking = rows("thinking");
  const working = rows("working");

  assert.equal(thinking[0].length, 12);
  assert.equal(working[2].length, 12);
  assert.equal(outline(thinking[0]), "...oo.oo.ooo");
  assert.equal(outline(idle[0]), "...oo.oo....");
  assert.equal(outline(working[2]), "..oo...oo...");
  assert.equal(outline(idle[2]), "..o....o....");
  assert.equal(working[2], "..oo.e.oo...");
  assert.notEqual(outline(thinking.join("")), outline(working.join("")));
});
