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
/** The editor the button will open: the chosen one, or the first found. */
export function effectiveEditor(config: GlobalConfig | undefined, editors: Editor[] = []): Editor | undefined {
  if (!config) return undefined;
  if (config.editor?.id === "custom") {
    return config.editor.command?.includes("{path}")
      ? { id: "custom", name: "your editor", available: true, command: config.editor.command }
      : undefined;
  }
  if (config.editor) return editors.find((e) => e.id === config.editor!.id && e.available);
  return automaticEditor(editors);
}

/** The menu item names the editor, so the reader knows what will open. */
export function editorMenuText(preparing: boolean, editorName = "editor") {
  return {
    label: preparing ? "preparing checkout…" : `open in ${editorName}`,
    hint: `Purview's own copy of this PR, detached at its head commit, in ${editorName}`,
  };
}
