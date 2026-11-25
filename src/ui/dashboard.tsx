// The dashboard: `agentcut ui` on a folder of projects. Lists them with a picture; open goes to the project's editor (its own server), create and duplicate add one.
import { useEffect, useState } from "preact/hooks";
import { api } from "./api.ts";
import { getLang, setLang, t, type Lang } from "./i18n.ts";
import { fail } from "./messages.ts";
import type { ApiError, Dict } from "./types.ts";

const go = (path: string, body: Dict, then: (r: Dict) => void) => api(path, body).then(then, (e: ApiError) => fail(e));

export function Dashboard() {
  const [d, setD] = useState<Dict | null>(null), [dup, setDup] = useState<string | null>(null), [, redraw] = useState(0);
  const [blank, setBlank] = useState<Record<string, true>>({}); // projects whose picture failed: an empty timeline has none
  const reload = () => { fetch("/api/projects").then((r) => r.json()).then((j) => (j.ok ? setD(j) : fail(j.error))); };
  useEffect(reload, []);
  const open = (name: string) => go("/api/open", { name }, (r) => { location.href = r.url; });
  const field = (e: Event, n: string) => ((e.currentTarget as HTMLFormElement).elements.namedItem(n) as HTMLInputElement).value.trim();
  return (
    <div id="dash">
      <header><b>AgentCut</b><span class="mut">{d ? d.dir : ""}</span>
        <select id="lang" aria-label={t("language")} value={getLang()} onChange={(e) => { setLang(e.currentTarget.value as Lang); redraw((n) => n + 1); }}>
          <option value="en">English</option><option value="vi">Tiếng Việt</option>
        </select>
      </header>
      <div id="msg" role="status" />
      <form id="dcreate" onSubmit={(e) => { e.preventDefault(); const name = field(e, "name"); if (name) go("/api/create", { name, preset: field(e, "preset") }, () => open(name)); }}>
        <input name="name" placeholder={t("dashName")} spellcheck={false} />
        <select name="preset">{(d ? d.presets : []).map((p: string) => <option value={p}>{p}</option>)}</select>
        <button class="primary">{t("dashCreate")}</button>
      </form>
      <div id="plist">
        {d && !d.projects.length && <div class="mut">{t("dashNone")}</div>}
        {d && d.projects.map((p: Dict) => (
          <div key={p.name} class="pcard" data-project={p.name}>
            <button class="popen" title={t("dashOpen")} onClick={() => open(p.name)}>
              {p.error || blank[p.name]
                ? <span class="pthumb none">{t("dashNoPicture")}</span>
                : <img class="pthumb" src={"/api/projects/" + encodeURIComponent(p.name) + "/thumb"} alt="" loading="lazy" onError={() => setBlank((b) => ({ ...b, [p.name]: true }))} />}
              <span class="aname">{p.name}</span>
              <span class={p.error ? "perr" : "mut"}>{p.error ? p.error : p.width + "x" + p.height + " · " + p.duration + " s · rev " + p.revision}</span>
              <span class="mut">{new Date(p.modified).toLocaleString(getLang())}</span>
            </button>
            {dup === p.name
              ? <form class="pdup" onSubmit={(e) => { e.preventDefault(); const as = field(e, "as"); if (as) go("/api/duplicate", { name: p.name, as }, () => { setDup(null); reload(); }); }}>
                  <input name="as" defaultValue={p.name + "-copy"} spellcheck={false} /><button>{t("dashDupGo")}</button>
                </form>
              : <button class="pdupb" onClick={() => setDup(p.name)}>{t("dashDup")}</button>}
          </div>
        ))}
      </div>
    </div>
  );
}
