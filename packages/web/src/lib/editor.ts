import type { Editor, GlobalConfig } from "../api/types";
export function editorAvailable(config: GlobalConfig | undefined, editors: Editor[] = []): boolean {
  if (!config) return false;
  if (config.editor?.id === "custom") return !!config.editor.command?.includes("{path}");
  if (config.editor) return editors.some(e => e.id === config.editor!.id && e.available);
  return editors.some(e => e.available);
}

/** The editor the button will use when nothing is chosen: the first one found. */
export function automaticEditor(editors: Editor[] = []): Editor | undefined {
  return editors.find(e => e.available);
}
export function editorMenuText(preparing: boolean) {
  return {
    label: preparing ? "Preparing checkout…" : "Open in editor",
    hint: "Purview's own copy of this PR, detached at its head commit",
  };
}
