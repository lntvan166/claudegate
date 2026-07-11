// Map a file path to a refractor (Prism) language id for syntax highlighting.
// Unknown extensions fall back to "text" (no highlighting, still renders).
const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
  json: "json", md: "markdown", py: "python", rb: "ruby", go: "go", rs: "rust",
  java: "java", c: "c", h: "c", cpp: "cpp", cc: "cpp", cs: "csharp", php: "php",
  sh: "bash", bash: "bash", zsh: "bash", yml: "yaml", yaml: "yaml", toml: "toml",
  html: "markup", xml: "markup", css: "css", scss: "scss", sql: "sql", swift: "swift",
  kt: "kotlin", dart: "dart",
};

export function languageFromPath(relPath: string): string {
  const base = relPath.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "text";
  return EXT_TO_LANG[base.slice(dot + 1).toLowerCase()] ?? "text";
}
