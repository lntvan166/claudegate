export interface PayloadFile {
  relPath: string; before: string | null; after: string | null;
  status: "pending" | "kept" | "undone"; isNew: boolean; isProtected: boolean;
  added: number; removed: number; missing: boolean; noChange: boolean; reason?: string;
}
export interface RenderMessage {
  type: "render"; files: PayloadFile[]; reviewedCount: number; totalCount: number; feedbackText: string;
}
export type DiffMode = "unified" | "split";
