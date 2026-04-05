import { resolve } from "node:path";
import { ViceSessionManager } from "./session-manager.js";

const managers = new Map<string, ViceSessionManager>();

export function getViceSessionManager(projectDir: string): ViceSessionManager {
  const key = resolve(projectDir);
  let manager = managers.get(key);
  if (!manager) {
    manager = new ViceSessionManager(key);
    managers.set(key, manager);
  }
  return manager;
}
