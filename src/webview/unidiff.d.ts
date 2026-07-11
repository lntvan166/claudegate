// unidiff ships no type declarations; we use only these two functions.
declare module "unidiff" {
  export function diffLines(before: string, after: string): unknown[];
  export function formatLines(changes: unknown[], options?: { context?: number; aname?: string; bname?: string }): string;
}
