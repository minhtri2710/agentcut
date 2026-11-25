import { ops } from "./api.ts";
import { t } from "./i18n.ts";
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

function importPath(ev: Event) {
  ev.preventDefault();
  const box = (ev.currentTarget as HTMLFormElement).elements.namedItem("path") as HTMLInputElement, path = box.value.trim();
  if (path) ops([{ op: "import_media", path }], "import " + fileName(path)).then((r) => { if (r) box.value = ""; });
}

export function Media() {
  const assets = st.S ? Object.entries(st.S.timeline.assets) : [], q = st.mediaQuery.toLowerCase();
  const shown = assets.filter(([id, a]) => !q || id.toLowerCase().includes(q) || fileName(a.path).toLowerCase().includes(q));
  const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.prototype.includes.call(e.dataTransfer.types, "Files");
  return (
    <div id="media" onDragOver={(e) => { if (hasFiles(e)) e.preventDefault(); }}
      onDrop={(e) => { if (!hasFiles(e)) return; e.preventDefault(); uploadAll(Array.from(e.dataTransfer!.files)); }}>
      <input id="msearch" type="search" placeholder={t("search")} value={st.mediaQuery} onInput={(e) => { st.mediaQuery = e.currentTarget.value; changed(); }} />
      <form id="mimport" onSubmit={importPath}>
        <input name="path" placeholder={t("importPath")} spellcheck={false} /><button>{t("importBtn")}</button>
      </form>
      <div class="mut">{st.uploading ? t("uploading", st.uploading) : t("dropHint")}</div>
      <div id="mlist">
        {!shown.length && <div class="mut">{t("noAssets")}</div>}
        {shown.map(([id, a]) => (
          <div key={id} class="asset" data-asset={id} draggable title={a.path} onDragStart={(e) => { e.dataTransfer!.setData(ASSET_DRAG, id); e.dataTransfer!.effectAllowed = "copy"; }}>
            {a.kind === "video" || a.kind === "image" ? <img src={"/api/thumb/" + encodeURIComponent(id) + "?t=0.00"} alt="" loading="lazy" /> : <div class="aicon">{a.kind}</div>}
            <div class="aname">{fileName(a.path) || id}</div>
            <div class="mut">{id + " · " + a.kind + (a.duration ? " · " + a.duration.toFixed(1) + " s" : "")}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
