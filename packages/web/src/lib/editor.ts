import type { Editor, GlobalConfig } from "../api/types";
export function editorAvailable(config: GlobalConfig | undefined, editors: Editor[] = []): boolean {
  if (!config) return false;
  if (config.editor?.id === "custom") return !!config.editor.command?.includes("{path}");
  if (config.editor) return editors.some(e => e.id === config.editor!.id && e.available);
  return editors.filter(e => e.available).length === 1;
}
export function editorMenuText(preparing: boolean) {
  return {
    label: preparing ? "Preparing checkout…" : "Open in editor",
    hint: "Purview's own copy of this PR, detached at its head commit",
  };
}
