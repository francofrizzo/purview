import { useState } from "react";
import { api } from "../api/client";
import { useEditors, useGlobalConfig, useSaveGlobalConfig } from "../api/hooks";
import { editorAvailable, editorMenuText } from "../lib/editor";
import { errorText } from "../api/errors";
import { Modal } from "./Modal";
import { IconCode, IconSpinner } from "./icons";
import { Section } from "./SettingsSections";

export function useOpenInEditor(prKey: string) {
  const config = useGlobalConfig();
  const editors = useEditors();
  const save = useSaveGlobalConfig();
  const [confirm, setConfirm] = useState(false);
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // The confirm box stays up while the checkout is prepared, so the wait is
  // visible there; from the menu (already confirmed) the item itself shows it.
  async function open() {
    setBusy(true);
    setError(undefined);
    try {
      if (remember && !config.data?.editorConfirmed) await save.mutateAsync({ editorConfirmed: true });
      await api.openInEditor(prKey);
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); setConfirm(false); }
  }
  return {
    items: editorAvailable(config.data, editors.data) ? [{
      ...editorMenuText(busy), disabled: busy, keepOpen: config.data?.editorConfirmed === true,
      testId: "menu-open-editor", icon: busy ? <IconSpinner width={12} height={12} /> : <IconCode width={12} height={12} />,
      onClick: () => config.data?.editorConfirmed ? void open() : setConfirm(true),
    }] : [],
    dialog: confirm || error ? <Modal title={error ? "Could not open editor" : "Open in editor"} maxWidth={520} onClose={() => { setConfirm(false); setError(undefined); }} testId="editor-confirm">
      {error ? <p role="alert">{error}</p> : <>
        <p>This opens Purview's own copy of the PR, detached at its head commit. Edits there are on no branch.</p>
        <label className="my-3 flex gap-2"><input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />Don't ask again</label>
        <div className="flex items-center gap-2">
          <button className="btn" disabled={busy} onClick={() => setConfirm(false)}>Cancel</button>
          <button className="btn btn-primary" disabled={busy} onClick={() => void open()}>{busy ? "Preparing checkout…" : "Open"}</button>
          {busy ? <IconSpinner width={12} height={12} /> : null}
        </div>
      </>}
    </Modal> : null,
  };
}

export function EditorSection() {
  const config = useGlobalConfig();
  const editors = useEditors();
  const save = useSaveGlobalConfig();
  const [command, setCommand] = useState<string>();
  const [choosingCustom, setChoosingCustom] = useState(false);
  const available = editors.data?.filter(e => e.available) ?? [];
  const selected = config.data?.editor;
  const value = choosingCustom ? "custom" : selected?.id ?? (available.length === 1 ? available[0].id : "");
  const custom = command ?? (selected?.id === "custom" ? selected.command ?? "" : "");
  return <Section id="editor" title="Editor">
    {editors.isLoading ? <p>Finding editors…</p> : <>
      {available.length === 0 && <p>No editor found on this machine</p>}
      <select aria-label="Editor" className="input" value={value} disabled={!config.data || save.isPending} onChange={e => {
        const id = e.target.value;
        setChoosingCustom(id === "custom");
        if (id !== "custom") save.mutate({ editor: id ? { id } : null });
      }}>
        <option value="">{available.length === 1 ? `Automatic (${available[0].name})` : "Choose an editor…"}</option>
        {available.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
        <option value="custom">Custom command…</option><option value="none">None</option>
      </select>
      {(value === "custom" || available.length === 0) && <div className="mt-2 flex gap-2">
        <input className="input" aria-label="Custom editor command" placeholder='editor "{path}"' value={custom} onChange={e => setCommand(e.target.value)} />
        <button className="btn" disabled={!custom.includes("{path}") || save.isPending} onClick={() => save.mutate({ editor: { id: "custom", command: custom } })}>Save</button>
      </div>}
    </>}
    <p className="mt-2 text-xs" style={{ color: "var(--fg-muted)" }}>Opens Purview's own copy of the PR, detached at its head commit, under ~/.purview/checkouts.</p>
    {(save.error || editors.error || config.error) && <p role="alert">{errorText(save.error || editors.error || config.error)}</p>}
  </Section>;
}
