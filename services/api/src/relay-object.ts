import { DurableObject, type DurableObjectState } from "cloudflare:workers";
import { HomeMailbox as MailboxRoom } from "./relay-mailbox.ts";
import { relayWorkerFetch, type RelayWorkerEnv } from "./relay-worker.ts";

export class HomeMailbox extends DurableObject<{ RELAY_ADMIN_TOKEN?: string }> {
  #room: MailboxRoom;

  constructor(ctx: DurableObjectState, env: { RELAY_ADMIN_TOKEN?: string }) {
    super(ctx, env);
    this.#room = new MailboxRoom(ctx, env);
  }

  fetch(request: Request): Promise<Response> {
    return this.#room.fetch(request);
  }

  alarm(): Promise<void> {
    return this.#room.alarm();
  }
}

export default {
  fetch(request: Request, env: RelayWorkerEnv): Promise<Response> {
    return relayWorkerFetch(request, env);
  },
};
