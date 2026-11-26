import { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { TextInput } from "@astryxdesign/core/TextInput";
import { FileAudio, Film, Upload } from "lucide-react";
import { ops } from "./api.ts";
import { t } from "./i18n.ts";
import { ico } from "./kit.tsx";
import { fail } from "./messages.ts";
import { changed, st } from "./state.ts";
import type { ApiError } from "./types.ts";

/** the drag type that carries an asset id from the media pool to a lane */
export const ASSET_DRAG = "application/x-agentcut-asset";

const fileName = (p?: string) => (p || "").split(/[\\/]/).pop() || "";

/** each dropped file goes to media/ (POST /api/upload), then one import_media, in turn */
async function uploadAll(files: File[]) {
  for (const f of files) {
    st.uploading = f.name; changed();
    try {
      const r = await fetch("/api/upload?name=" + encodeURIComponent(f.name), { method: "POST", headers: { "content-type": "application/octet-stream" }, body: f }).then((x) => x.json());
      if (!r.ok) throw r.error as ApiError;
      if (!(await ops([{ op: "import_media", path: r.path }], "import " + f.name))) break;
    } catch (e) { fail(e as ApiError); break; }
  }
  st.uploading = null; changed();
}

export function Media() {
  const [path, setPath] = useState("");
  const assets = st.S ? Object.entries(st.S.timeline.assets) : [], q = st.mediaQuery.toLowerCase();
  const shown = assets.filter(([id, a]) => !q || id.toLowerCase().includes(q) || fileName(a.path).toLowerCase().includes(q));
  const hasFiles = (e: React.DragEvent) => !!e.dataTransfer && Array.prototype.includes.call(e.dataTransfer.types, "Files");
  const importPath = (e: React.FormEvent) => {
    e.preventDefault();
    const p = path.trim();
    if (p) ops([{ op: "import_media", path: p }], "import " + fileName(p)).then((r) => { if (r) setPath(""); });
  };
  return (
    <div id="media" className="pbody" onDragOver={(e) => { if (hasFiles(e)) e.preventDefault(); }}
      onDrop={(e) => { if (!hasFiles(e)) return; e.preventDefault(); uploadAll(Array.from(e.dataTransfer!.files)); }}>
      <TextInput id="msearch" type="search" size="sm" label={t("search")} isLabelHidden startIcon="search" placeholder={t("search")} value={st.mediaQuery} onChange={(v) => { st.mediaQuery = v; changed(); }} />
      <form id="mimport" className="row" onSubmit={importPath}>
        <TextInput htmlName="path" size="sm" label={t("importBtn")} isLabelHidden placeholder={t("importPath")} hasSpellCheck={false} value={path} onChange={setPath} width="100%" />
        <Button type="submit" size="sm" label={t("importBtn")} />
      </form>
      <div className="drop mut">{ico(Upload)}<span>{st.uploading ? t("uploading", st.uploading) : t("dropHint")}</span></div>
      <div id="mlist">
        {!shown.length && <EmptyState isCompact icon={ico(Film)} title={t("noAssets")} />}
        {shown.map(([id, a]) => (
          <div key={id} className="asset" data-asset={id} draggable title={a.path} onDragStart={(e) => { e.dataTransfer.setData(ASSET_DRAG, id); e.dataTransfer.effectAllowed = "copy"; }}>
            {a.kind === "video" || a.kind === "image" ? <img src={"/api/thumb/" + encodeURIComponent(id) + "?t=0.00"} alt="" loading="lazy" /> : <div className="aicon">{ico(FileAudio)}</div>}
            {a.duration ? <span className="adur mono">{a.duration.toFixed(1) + " s"}</span> : null}
            <div className="aname">{fileName(a.path) || id}</div>
            <div className="mut">{id + " · " + a.kind}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
