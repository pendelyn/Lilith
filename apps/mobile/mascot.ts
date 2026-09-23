import type { TaskState } from "@lilith/contracts";

export const MASCOT_STATES = [
  "idle",
  "thinking",
  "delegating",
  "working",
  "waiting",
  "success",
  "error",
] as const;

export type MascotState = (typeof MASCOT_STATES)[number];

export type MascotConnection =
  | "idle"
  | "loading"
  | "streaming"
  | "success"
  | "unauthorized"
  | "unreachable"
  | "unexpected";

export type MascotCard = {
  state: TaskState;
  browser?: unknown;
};

export type MascotMessage = {
  role: "user" | "assistant";
  status: "sent" | "streaming" | "complete" | "failed";
  subagents?: readonly MascotCard[];
};

export type MascotActivity = {
  connection: MascotConnection;
  messages: readonly MascotMessage[];
};

/** Outline, fill, eye, success, and error. `.` is empty. */
export const MASCOT_PIXELS = {
  o: "outline",
  f: "fill",
  e: "eye",
  s: "success",
  r: "error",
} as const;

export type MascotPixel = keyof typeof MASCOT_PIXELS;

// Side-view sitting cat. States share the body and tail; eyes, ears, and the
// delegating paw are the differences. 12×10.
const MASCOT_SPRITES: Record<MascotState, readonly string[]> = {
  idle: [
    "...oo.oo....",
    "..offffo....",
    "..ofeefo....",
    "..offffoo...",
    ".ooffffo....",
    "ooffffff....",
    "offffo......",
    "oo.ffo......",
    "o..oo.......",
    ".oooo.......",
  ],
  thinking: [
    "...oo.oo.o..",
    "..oeeffo....",
    "..offffo....",
    "..offffoo...",
    ".ooffffo....",
    "ooffffff....",
    "offffo......",
    "oo.ffo......",
    "o..oo.......",
    ".oooo.......",
  ],
  delegating: [
    "...oo.oo....",
    "..offffo....",
    "..offeefo...",
    "..offffoo...",
    ".ooffffo....",
    "ooffffffooo.",
    "offffoooo...",
    "oo.ffo......",
    "o..oo.......",
    ".oooo.......",
  ],
  working: [
    "...oo.oo....",
    "..offffo....",
    "..of.e.fo...",
    "..offffoo...",
    ".ooffffo....",
    "ooffffff....",
    "offffo......",
    "oo.ffo......",
    "o..oo.......",
    ".oooo.......",
  ],
  waiting: [
    "...oo.oo....",
    "..offffo....",
    "..ofoofo....",
    "..offffoo...",
    ".ooffffo....",
    "ooffffff....",
    "offffo......",
    "oo.ffo......",
    "o..oo.......",
    ".oooo.......",
  ],
  success: [
    "...oo.oo....",
    "..offffo....",
    "..ofssfo....",
    "..offffoo...",
    ".ooffffo....",
    "ooffffff....",
    "offffo......",
    "oo.ffo......",
    "o..oo.......",
    ".oooo.......",
  ],
  error: [
    "...rr.rr....",
    "..offffo....",
    "..ofrrfo....",
    "..offffoo...",
    ".ooffffo....",
    "ooffffff....",
    "offffo......",
    "oo.ffo......",
    "o..oo.......",
    ".oooo.......",
  ],
};

const CARD_PRECEDENCE = ["error", "waiting", "working", "delegating"] as const;
type CardPose = (typeof CARD_PRECEDENCE)[number];

// This build has no blink or bob. Reduced motion still forces the flag off
// so a later nonessential frame cannot play when the OS asks for stillness.
const NONESSENTIAL_ANIMATION = false;

export type MascotPresentation = {
  state: MascotState;
  rows: readonly string[];
  animate: boolean;
};

function latestAssistant(messages: readonly MascotMessage[]): MascotMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant") return message;
  }
  return undefined;
}

function connectionFault(connection: MascotConnection): boolean {
  return connection === "unauthorized" || connection === "unreachable" || connection === "unexpected";
}

// Queued subagents start in task state `waiting` (delegation). `needs_input`
// and `paused` are the waiting pose. A browser timeline on a still-queued
// card is already work. Terminal cards, including leftover browser history,
// do not hold a pose.
function poseForCard(card: MascotCard): CardPose | undefined {
  if (card.state === "failed") return "error";
  if (card.state === "needs_input" || card.state === "paused") return "waiting";
  if (card.state === "working") return "working";
  if (card.browser !== undefined && card.state === "waiting") return "working";
  if (card.state === "waiting") return "delegating";
  return undefined;
}

function bestCard(cards: readonly MascotCard[] | undefined): CardPose | undefined {
  if (cards === undefined) return undefined;
  let best: CardPose | undefined;
  for (const card of cards) {
    const pose = poseForCard(card);
    if (pose === undefined) continue;
    if (best === undefined || CARD_PRECEDENCE.indexOf(pose) < CARD_PRECEDENCE.indexOf(best)) {
      best = pose;
    }
  }
  return best;
}

// Highest first: connection fault, failed latest reply, then that reply's
// cards, then an in-flight stream (thinking), then a completed latest reply
// (success). Idle is no reply yet. Only the latest assistant message counts.
// Success stays until the next reply; there is no timer event to clear it.
export function selectMascotState(activity: MascotActivity): MascotState {
  if (connectionFault(activity.connection)) return "error";
  const assistant = latestAssistant(activity.messages);
  if (assistant?.status === "failed") return "error";
  const card = bestCard(assistant?.subagents);
  if (card !== undefined) return card;
  if (activity.connection === "streaming" || assistant?.status === "streaming") return "thinking";
  if (assistant?.status === "complete") return "success";
  return "idle";
}

export function mascotPresentation(state: MascotState, reduceMotion: boolean): MascotPresentation {
  return {
    state,
    rows: MASCOT_SPRITES[state],
    animate: reduceMotion ? false : NONESSENTIAL_ANIMATION,
  };
}
