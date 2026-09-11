import {
  parseMemoryConfirmRequest,
  parseMemoryConfirmResponse,
  parseMemoryItem,
  parseMemoryListResponse,
  parseMemoryPauseRequest,
  type MemoryItem,
} from "@lilith/contracts";
import type { AgentIdentity } from "./identity.ts";

export type { MemoryItem };
export {
  parseMemoryConfirmRequest,
  parseMemoryConfirmResponse,
  parseMemoryItem,
  parseMemoryListResponse,
  parseMemoryPauseRequest,
};

export function memoryEnabledFromIdentity(identity: AgentIdentity | null): boolean {
  return identity?.tools.includes("memory") === true;
}

export function memoryRowAccessibilityLabel(action: string, content: string, updatedAt: number): string {
  const snippet = content.trim().replace(/\s+/g, " ").slice(0, 32);
  return `${action} memory, ${snippet || new Date(updatedAt).toLocaleString()}`;
}

export function replaceMemory(memories: MemoryItem[], updated: MemoryItem): MemoryItem[] {
  let found = false;
  const next = memories.map((item) => {
    if (item.id !== updated.id) return item;
    found = true;
    return updated;
  });
  return found ? next : memories;
}

export function removeMemory(memories: MemoryItem[], id: string): MemoryItem[] {
  return memories.filter((item) => item.id !== id);
}
