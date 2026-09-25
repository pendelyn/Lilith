declare module "cloudflare:workers" {
  export interface DurableObjectState {
    storage: {
      get(key: string): Promise<unknown>;
      put(key: string, value: unknown): Promise<void>;
      delete(key: string): Promise<boolean>;
      setAlarm(scheduledTime: number | Date): Promise<void>;
      getAlarm(): Promise<number | null>;
      deleteAlarm(): Promise<void>;
    };
  }

  export abstract class DurableObject<Env = unknown> {
    ctx: DurableObjectState;
    env: Env;
    constructor(ctx: DurableObjectState, env: Env);
  }
}
