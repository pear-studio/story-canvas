import { useId, useState } from "react";

import { Modal } from "./Modal";

const entityIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function suggestedId(name: string, fallback: string) {
  const id = name.toLowerCase().normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return id || fallback;
}

export function NamedEntityCreateDialog({ kind, ownerName, existingIds, onClose, onCreate }: {
  kind: "character" | "variant" | "scene";
  ownerName?: string;
  existingIds: string[];
  onClose: () => void;
  onCreate: (value: { id: string; name: string }) => Promise<boolean>;
}) {
  const formId = useId();
  const isCharacter = kind === "character";
  const entityLabel = isCharacter ? "角色" : kind === "scene" ? "场景" : "子设定";
  const fallbackId = kind;
  const reservedId = isCharacter ? "npc" : kind === "variant" ? "main" : null;
  const [name, setName] = useState("");
  const [id, setId] = useState<string>(fallbackId);
  const [idEdited, setIdEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const normalizedId = id.trim();
  const normalizedName = name.trim();
  const idError = !entityIdPattern.test(normalizedId)
    ? "ID 只能使用小写字母、数字和连字符。"
    : normalizedId === reservedId
      ? `不能使用保留 ID：${reservedId}`
      : existingIds.includes(normalizedId)
        ? `ID “${normalizedId}” 已存在。`
        : "";

  async function submit() {
    if (!normalizedName || idError || busy) return;
    setBusy(true);
    try {
      if (await onCreate({ id: normalizedId, name: normalizedName })) onClose();
    } finally {
      setBusy(false);
    }
  }

  return <Modal size="content" title={`新建${entityLabel}`} subtitle={kind !== "variant" ? "同时指定显示名和稳定 ID" : `${ownerName ?? "角色"} · 同时指定显示名和稳定 ID`} onClose={onClose} busy={busy} className="named-entity-create-dialog" footer={<><button type="button" className="button button--quiet" disabled={busy} onClick={onClose}>取消</button><button type="submit" form={formId} className="button button--primary" disabled={busy || !normalizedName || Boolean(idError)}>{busy ? "创建中…" : `创建${entityLabel}`}</button></>}>
    <form id={formId} className="named-entity-create-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <label><span>显示名</span><input autoFocus value={name} maxLength={100} placeholder={isCharacter ? "例如：王小美" : kind === "scene" ? "例如：空间站走廊" : "例如：常服"} disabled={busy} onChange={(event) => { const nextName = event.target.value; setName(nextName); if (!idEdited) setId(suggestedId(nextName, fallbackId)); }} /></label>
      <label><span>{entityLabel} ID</span><input className={idError ? "is-missing mono-input" : "mono-input"} value={id} spellCheck={false} disabled={busy} onChange={(event) => { setIdEdited(true); setId(event.target.value.toLowerCase()); }} /><small>ID 会用于文件与引用；创建后不要随意修改。</small>{idError && <small className="named-entity-create-error" role="alert">{idError}</small>}</label>
    </form>
  </Modal>;
}
