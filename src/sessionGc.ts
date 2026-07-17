import * as fs from "fs";
import * as path from "path";

/**
 * True when a session file is safe to garbage-collect: EVERY file it references
 * lives in a directory that no longer exists on disk, so none of its pending
 * baselines could ever be restored. If even one referenced file's directory
 * still exists, the session is kept — a deliberately conservative rule that
 * spares live and partially-live workspaces. Checking each file's PARENT
 * directory (not the file itself) keeps new-file captures — whose target may
 * not be written yet — alive as long as their project dir exists. Never
 * age-based: an old session whose tree survives may hold unreviewed work.
 */
export function isOrphanedSession(
  paths: string[],
  dirExists: (dir: string) => boolean
): boolean {
  if (paths.length === 0) return false; // no paths — can't tell — keep
  return paths.every((p) => !dirExists(path.dirname(p)));
}

/** Every absolute file path a session records: pending, accepted, and rejected. */
export function referencedPaths(session: unknown): string[] {
  const s = (session ?? {}) as {
    files?: Record<string, unknown>;
    accepted?: Array<{ path?: string }>;
    rejected?: Record<string, unknown>;
  };
  const paths: string[] = [];
  if (s.files) paths.push(...Object.keys(s.files));
  if (Array.isArray(s.accepted)) {
    for (const r of s.accepted) if (r?.path) paths.push(r.path);
  }
  if (s.rejected) paths.push(...Object.keys(s.rejected));
  return paths;
}

function dirExistsOnDisk(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Delete every session file under `sessionsDir` whose workspace tree is gone
 * from disk (see isOrphanedSession). Reclaims space left by deleted workspaces
 * and stray test fixtures without ever touching a live workspace's session.
 * Fail-soft: unparseable files and unlink errors are skipped, not thrown, so a
 * bad file can't abort activation. Returns the filenames actually deleted.
 */
export function gcOrphanedSessions(
  sessionsDir: string,
  opts: { dirExists?: (dir: string) => boolean; log?: (msg: string) => void } = {}
): string[] {
  const dirExists = opts.dirExists ?? dirExistsOnDisk;
  let entries: string[];
  try {
    entries = fs.readdirSync(sessionsDir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const deleted: string[] = [];
  for (const name of entries) {
    const full = path.join(sessionsDir, name);
    let session: unknown;
    try {
      session = JSON.parse(fs.readFileSync(full, "utf-8"));
    } catch {
      continue; // unparseable → can't inspect → keep
    }
    if (!isOrphanedSession(referencedPaths(session), dirExists)) continue;
    try {
      fs.unlinkSync(full);
      deleted.push(name);
      opts.log?.(`[INFO] GC removed orphaned session (workspace tree gone): ${name}`);
    } catch (err) {
      opts.log?.(`[WARN] GC could not remove ${name}: ${(err as Error).message}`);
    }
  }
  return deleted;
}
