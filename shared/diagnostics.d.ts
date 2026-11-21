export interface ConnectionReport {
  service: { running: boolean; status: string; address: string };
  adapters: { name: string; status: string; configured: boolean; configPath?: string; received?: string }[];
  lastInstall?: { ok: boolean; summary: string; detail: string };
  lastFailure?: { at: string; target: string; reason: string };
}
