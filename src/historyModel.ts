// Pure, vscode-free parsing/filtering of session archives written by
// clearSession to ~/.claudegate/history/. Runs under plain node for tests.
import * as path from "path";

export interface HistoryRecordRef {
  id: string;
  path: string;
  kind: "kept" | "rejected";
  before: string | null;
  after: string | null;
  reason?: string;
  decidedAt?: string;
}

export interface HistoryArchiveSummary {
  file: string;
  sessionId: string;
  label: string;      // local "YYYY-MM-DD HH:mm", or the raw sessionId
  kept: number;
  rejected: number;
  bytes: number;
  records: HistoryRecordRef[];
}

// Local copy of the 3-line containment check so this module stays free of
// vscode imports (workspaceScope pulls in vscode at module load).
function isPathUnder(child: string, parent: string, caseInsensitive: boolean): boolean {
  const norm = (p: string) => (caseInsensitive ? p.toLowerCase() : p);
  return norm(child).startsWith(norm(parent) + path.sep);
}

// Decided records only: accepted[] + rejected{}. Pending files{} entries have
// no stored "after" content, so they can't render a view-only diff.
function decidedRecords(raw: any): HistoryRecordRef[] {
  const out: HistoryRecordRef[] = [];
  if (Array.isArray(raw?.accepted)) {
    for (const r of raw.accepted) {
      if (!r || typeof r.path !== "string") continue;
      out.push({ id: String(r.id ?? `${r.decidedAt}::${r.path}`), path: r.path, kind: "kept",
        before: r.before ?? null, after: r.after ?? null, decidedAt: r.decidedAt });
    }
  }
  if (raw?.rejected && typeof raw.rejected === "object") {
    for (const r of Object.values<any>(raw.rejected)) {
      if (!r || typeof r.path !== "string") continue;
      out.push({ id: String(r.id ?? `${r.decidedAt}::${r.path}`), path: r.path, kind: "rejected",
        before: r.before ?? null, after: r.after ?? null,
        ...(r.reason ? { reason: r.reason } : {}), decidedAt: r.decidedAt });
    }
  }
  return out;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function summarizeArchive(file: string, raw: unknown, bytes: number): HistoryArchiveSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const records = decidedRecords(raw);
  if (records.length === 0) return null; // nothing viewable → skip archive
  const sessionId = typeof (raw as any).sessionId === "string" ? (raw as any).sessionId : path.basename(file, ".json");
  const t = Date.parse(sessionId);
  const label = Number.isNaN(t)
    ? sessionId
    : (() => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; })();
  return {
    file, sessionId, label, bytes, records,
    kept: records.filter((r) => r.kind === "kept").length,
    rejected: records.filter((r) => r.kind === "rejected").length,
  };
}

// workspacePath (embedded by archiveSession since this feature) wins outright;
// legacy archives fall back to "any decided record path under the root".
export function archiveMatchesWorkspace(
  raw: unknown,
  workspaceRoot: string,
  caseInsensitive: boolean = process.platform === "win32"
): boolean {
  const root = path.resolve(workspaceRoot);
  const wp = (raw as any)?.workspacePath;
  if (typeof wp === "string") {
    const a = path.resolve(wp);
    return caseInsensitive ? a.toLowerCase() === root.toLowerCase() : a === root;
  }
  return decidedRecords(raw).some((r) => isPathUnder(r.path, root, caseInsensitive));
}

export function findArchiveRecord(raw: unknown, id: string): HistoryRecordRef | null {
  if (!raw || typeof raw !== "object") return null;
  return decidedRecords(raw).find((r) => r.id === id) ?? null;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}
