import { useRef, useState } from "react";
import { api } from "../api/client";
import type { GlobalConfig } from "../api/types";
import { useEditors, useGlobalConfig, useSaveGlobalConfig } from "../api/hooks";
import { effectiveEditor } from "../lib/editor";
import { errorText } from "../api/errors";
import { Modal } from "./Modal";
import { FloatingPanel } from "./FloatingPanel";
import { IconCheck, IconCode, IconSpinner } from "./icons";
import { Section } from "./SettingsSections";

type Selection = NonNullable<GlobalConfig["editor"]>;

export function useOpenInEditor(prKey: string) {
  const config = useGlobalConfig();
  const save = useSaveGlobalConfig();
  const [selection, setSelection] = useState<Selection>();
  const [confirm, setConfirm] = useState(false);
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function open(editor: Selection) {
    setBusy(true);
    setError(undefined);
    try {
      await save.mutateAsync({ editor, ...(remember ? { editorConfirmed: true } : {}) });
      await api.openInEditor(prKey, editor);
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); setConfirm(false); }
  }
  return {
    busy,
    pick(editor: Selection, name: string) {
      setSelection({ ...editor, name });
      if (config.data?.editorConfirmed) void open(editor);
      else setConfirm(true);
    },
    dialog: confirm || error ? <Modal title={error ? "Could not open editor" : "Open in editor"} maxWidth={520} onClose={() => { if (!busy) { setConfirm(false); setError(undefined); } }} testId="editor-confirm">
      {error ? <p role="alert" className="text-xs" style={{ color: "var(--risk)" }}>{error}</p> : <>
        <p className="text-xs leading-5">This opens Purview's own copy of the PR in {selection?.name ?? "your editor"}, detached at its head commit. Edits there are on no branch.</p>
        <label className="my-3 flex items-center gap-2 text-xs"><input type="checkbox" disabled={busy} checked={remember} onChange={e => setRemember(e.target.checked)} />Don't show again</label>
        <div className="flex items-center gap-2">
          <button className="btn" disabled={busy} onClick={() => setConfirm(false)}>Cancel</button>
          <button className="btn btn-primary" disabled={busy} onClick={() => selection && void open(selection.id === "custom" ? selection : { id: selection.id })}>{busy ? "Preparing checkout…" : "Open"}</button>
          {busy ? <IconSpinner width={12} height={12} /> : null}
        </div>
      </>}
    </Modal> : null,
  };
}

function CustomEditorForm({ initial, busy, onSave }: { initial?: Selection | null; busy: boolean; onSave: (editor: Selection) => void }) {
  const [name, setName] = useState(initial?.id === "custom" ? initial.name ?? "" : "");
  const [command, setCommand] = useState(initial?.id === "custom" ? initial.command ?? "" : "");
  return <form className="mt-2" onSubmit={e => { e.preventDefault(); if (command.includes("{path}") && !busy) onSave({ id: "custom", name: name.trim(), command }); }}>
    <div className="flex flex-wrap gap-2">
      <input className="input min-w-0 flex-1" aria-label="Custom editor name" placeholder="Nova" value={name} onChange={e => setName(e.target.value)} />
      <input className="input min-w-0 flex-1" aria-label="Custom editor command" placeholder="nova {path}" value={command} onChange={e => setCommand(e.target.value)} />
      <button className="btn" disabled={!command.includes("{path}") || busy}>Save</button>
    </div>
    <p className="mt-2 text-xs" style={{ color: "var(--fg-muted)" }}>The folder replaces {"{path}"}. Quoted arguments are fine; no shell variables or pipes.</p>
  </form>;
}

export function EditorButton({ prKey }: { prKey: string }) {
  const config = useGlobalConfig();
  const editors = useEditors();
  const flow = useOpenInEditor(prKey);
  const anchor = useRef<HTMLButtonElement>(null);
  const [panel, setPanel] = useState(false);
  const [custom, setCustom] = useState(false);
  const available = editors.data?.filter(e => e.available) ?? [];
  const selected = effectiveEditor(config.data, editors.data);
  const customEditor = config.data?.editor?.id === "custom" ? effectiveEditor(config.data, []) : undefined;
  const choices = customEditor ? [...available, customEditor] : available;
  const choose = (editor: Selection, name: string) => { setPanel(false); flow.pick(editor, name); };
  return <>
    <button ref={anchor} type="button" className="btn" data-testid="topbar-editor" aria-label={flow.busy ? "preparing checkout…" : "open in editor"} aria-haspopup="dialog" aria-expanded={panel} disabled={flow.busy} data-tip={flow.busy ? "Preparing checkout…" : "Open in editor: Purview's own copy of this PR, detached at its head commit"} onClick={() => { setCustom(false); setPanel(!panel); }}>
      {flow.busy ? <IconSpinner width={12} height={12} /> : <IconCode width={12} height={12} />}
    </button>
    {panel && <FloatingPanel anchorRef={anchor} onClose={() => setPanel(false)} label="Open in editor" className="w-80 max-w-[calc(100vw-16px)] p-2">
      {editors.isLoading || config.isLoading ? <p className="text-xs">Finding editors…</p> : custom || choices.length === 0 ? <>
        {choices.length === 0 && <p className="text-xs">No editor found on this machine</p>}
        <CustomEditorForm initial={config.data?.editor} busy={flow.busy || !config.data} onSave={editor => choose(editor, editor.name || "your editor")} />
        {choices.length > 0 && <button className="btn mt-2" onClick={() => setCustom(false)}>Back</button>}
      </> : <>
        {choices.map(editor => <button key={editor.id} type="button" className="flex w-full items-center justify-between rounded px-2 py-1.5 text-xs hover:bg-[var(--bg-inset)]" data-testid={`editor-pick-${editor.id}`} aria-pressed={selected?.id === editor.id} onClick={() => choose(editor.id === "custom" ? { id: editor.id, name: editor.name, command: editor.command } : { id: editor.id }, editor.name)}>
          {editor.name}{selected?.id === editor.id && <IconCheck width={12} height={12} />}
        </button>)}
        <div className="my-1 border-t border-[var(--border)]" />
        <button className="w-full rounded px-2 py-1.5 text-left text-xs hover:bg-[var(--bg-inset)]" onClick={() => setCustom(true)}>Custom command…</button>
      </>}
      {(editors.error || config.error) && <p role="alert" className="text-xs">{errorText(editors.error || config.error)}</p>}
    </FloatingPanel>}
    {flow.dialog}
  </>;
}

export function EditorSection() {
  const config = useGlobalConfig();
  const editors = useEditors();
  const save = useSaveGlobalConfig();
  const [choosingCustom, setChoosingCustom] = useState(false);
  const available = editors.data?.filter(e => e.available) ?? [];
  const selected = config.data?.editor;
  const value = choosingCustom ? "custom" : selected?.id ?? "";
  return <Section id="editor" title="Editor">
    {editors.isLoading ? <p>Finding editors…</p> : <>
      {available.length === 0 && <p>No editor found on this machine</p>}
      <select aria-label="Editor" className="input" value={value} disabled={!config.data || save.isPending} onChange={e => {
        const id = e.target.value;
        setChoosingCustom(id === "custom");
        if (id !== "custom") save.mutate({ editor: id ? { id } : null });
      }}>
        <option value="">{available[0] ? `Automatic (${available[0].name})` : "Choose an editor…"}</option>
        {available.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
        <option value="custom">{selected?.id === "custom" && selected.name ? selected.name : "Custom command…"}</option><option value="none">None</option>
      </select>
      {(value === "custom" || available.length === 0) && <CustomEditorForm key={`${selected?.name}:${selected?.command}`} initial={selected} busy={save.isPending || !config.data} onSave={editor => save.mutate({ editor })} />}
    </>}
    <p className="mt-2 text-xs" style={{ color: "var(--fg-muted)" }}>Opens Purview's own copy of the PR, detached at its head commit, under ~/.purview/checkouts.</p>
    {(save.error || editors.error || config.error) && <p role="alert">{errorText(save.error || editors.error || config.error)}</p>}
  </Section>;
}
