// The dashboard: `agentcut ui` on a folder of projects. Lists them with a picture; open goes to the project's editor (its own server), create and duplicate add one.
import { useEffect, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Selector } from "@astryxdesign/core/Selector";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Clapperboard, Copy, FolderPlus, ImageOff } from "lucide-react";
import { api } from "./api.ts";
import { getLang, setLang, t } from "./i18n.ts";
import { Frame, ico, LangSwitch } from "./kit.tsx";
import { fail } from "./messages.ts";
import type { ApiError, Dict } from "./types.ts";

const go = (path: string, body: Dict, then: (r: Dict) => void) => api(path, body).then(then, (e: ApiError) => fail(e));

function Card({ p, onOpen, reload }: { p: Dict; onOpen: () => void; reload: () => void }) {
  const [dup, setDup] = useState<string | null>(null), [blank, setBlank] = useState(false); // an empty timeline has no picture
  return (
    <div className="pcard" data-project={p.name}>
      <button type="button" className="popen" title={t("dashOpen")} onClick={onOpen}>
        {p.error || blank
          ? <span className="pthumb none">{ico(ImageOff)}<span>{t("dashNoPicture")}</span></span>
          : <img className="pthumb" src={"/api/projects/" + encodeURIComponent(p.name) + "/thumb"} alt="" loading="lazy" onError={() => setBlank(true)} />}
        <span className="aname">{p.name}</span>
        <span className={p.error ? "perr" : "mut mono"}>{p.error ? p.error : p.width + "x" + p.height + " · " + p.duration + " s · rev " + p.revision}</span>
        <span className="mut">{new Date(p.modified).toLocaleString(getLang())}</span>
      </button>
      {dup !== null
        ? <form className="pdup row" onSubmit={(e) => { e.preventDefault(); const as = dup.trim(); if (as) go("/api/duplicate", { name: p.name, as }, () => { setDup(null); reload(); }); }}>
            <TextInput htmlName="as" size="sm" label={t("dashDup")} isLabelHidden hasSpellCheck={false} hasAutoFocus value={dup} onChange={setDup} width="100%" />
            <Button type="submit" size="sm" variant="primary" label={t("dashDupGo")} />
          </form>
        : <div className="row"><Button className="pdupb" size="sm" variant="ghost" icon={ico(Copy)} label={t("dashDup")} onClick={() => setDup(p.name + "-copy")} /></div>}
    </div>
  );
}

export function Dashboard() {
  const [d, setD] = useState<Dict | null>(null), [, redraw] = useState(0), [name, setName] = useState(""), [preset, setPreset] = useState<string | null>(null);
  const reload = () => { fetch("/api/projects").then((r) => r.json()).then((j) => (j.ok ? setD(j) : fail(j.error))); };
  useEffect(reload, []);
  const open = (n: string) => go("/api/open", { name: n }, (r) => { location.href = r.url; });
  const presets: string[] = d ? d.presets : [];
  return (
    <Frame>
      <div id="dash">
        <header id="top">
          <span className="brand"><span className="logo">{ico(Clapperboard)}</span><b>AgentCut</b></span>
          <span className="mut mono grow">{d ? d.dir : ""}</span>
          <LangSwitch onPick={(l) => { setLang(l); document.documentElement.lang = l; redraw((n) => n + 1); }} />
        </header>
        <main className="dmain">
          <div className="dhero"><span className="logo">{ico(Clapperboard)}</span><h1>{t("dashHero")}</h1></div>
          <form id="dcreate" className="row" onSubmit={(e) => { e.preventDefault(); const n = name.trim(); if (n) go("/api/create", { name: n, preset: preset ?? presets[0] }, () => open(n)); }}>
            <TextInput htmlName="name" size="sm" label={t("dashName")} isLabelHidden placeholder={t("dashName")} hasSpellCheck={false} value={name} onChange={setName} width={280} />
            <Selector htmlName="preset" size="sm" label="preset" isLabelHidden value={preset ?? presets[0] ?? null} options={presets} onChange={setPreset} width={160} />
            <Button type="submit" size="sm" variant="primary" icon={ico(FolderPlus)} label={t("dashCreate")} />
          </form>
          <div id="plist">
            {d && d.projects.map((p: Dict) => <Card key={p.name} p={p} onOpen={() => open(p.name)} reload={reload} />)}
          </div>
          {d && !d.projects.length && <EmptyState icon={ico(Clapperboard)} title={t("dashNone")} />}
        </main>
        <div id="msg" role="status" aria-live="polite" onClick={(e) => { e.currentTarget.className = ""; }} />
      </div>
    </Frame>
  );
}
