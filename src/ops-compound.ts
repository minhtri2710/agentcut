// Compound clips (Final Cut "compound clip" / CapCut "group"): make_compound, expand_compound.
import {
  allClips, type Clip, clipDur, clipEnd, clipStart, EditError, findClip, iterClips, newId, normAnim, parseTime, resolve, round6,
  type Timeline, type Track,
} from "./model.ts";
import type { OpHelpers } from "./ops.ts";
import { AUDIO_FX_KEYS } from "./audiofx.ts";

const EPS = 1e-6;
const TRACK_PROPS = ["name", "role", "duck", "volume", "muted", "hidden", ...AUDIO_FX_KEYS];
const detach = (c: Clip) => { for (const k of ["attach_to", "offset", "match_duration", "end_offset"]) delete c[k]; };
const gap = (d: number): Clip => ({ id: "", type: "gap", duration: round6(Math.max(0.001, d)) });

/** Pin a magnetic clip's transition to its resolved overlap td, so a neighbour with another duration cannot move it. */
function pin(c: Clip | undefined, td: number) {
  const spec = c?.transition ? normAnim(c.transition, 0.5) : null;
  if (!c || !spec) return;
  if (td < EPS) delete c.transition;
  else if (Math.abs(spec.duration - td) > EPS) c.transition = { ...spec, duration: round6(td) };
}

/** Cut `head`/`tail` seconds off a clip, keeping its content locked to the timeline. */
function trim(n: Clip, head: number, tail: number) {
  if (head < EPS && tail < EPS) return;
  const sp = Number(n.speed ?? 1) || 1, d = n.reverse ? tail : head;
  if (["video", "audio", "lottie", "compound"].includes(n.type) && !n.freeze && d > EPS) n.in = round6(parseTime(n.in ?? 0) + d * sp);
  if (head > EPS) {
    delete n.transition; delete n.fade_in;
    for (const [k, list] of Object.entries(n.keyframes ?? {})) if (k !== "speed" && Array.isArray(list))
      n.keyframes[k] = list.map((x: any) => (Array.isArray(x) ? [round6(parseTime(x[0]) - head), ...x.slice(1)] : x));
    if (n.type === "captions" && Array.isArray(n.words))
      n.words = n.words.map((w: any) => ({ ...w, start: round6(w.start - head), end: round6(w.end - head) })).filter((w: any) => w.end > 0);
  }
  if (tail > EPS) delete n.fade_out;
  n.duration = round6(clipDur(n) - head - tail);
}

export function registerCompoundOps(h: OpHelpers) {
  h.PREFIX.compound ??= "cmp";
  const fillGaps = (tl: Timeline, gaps: Clip[]) => gaps.map((g) => (g.id = newId(tl, "gap")));

  /** the clips (and gaps) expand_compound stamped with `group.id === from`, on the group's home track first (the first id picks the compound's track) */
  const stampedIds = (tl: Timeline, from: string): { ids: string[]; name?: string; parent?: Clip } => {
    const found = tl.tracks.flatMap((tr) => tr.clips.filter((c) => c.group?.id === from).map((c) => ({ tr, c })));
    if (!found.length) throw new EditError(`no clips are stamped with group '${from}'`, "no_group", "from regroups the clips expand_compound placed; see each clip's 'group' field, or pass ids");
    const inner = [...new Set(tl.tracks.flatMap((tr) => tr.clips).flatMap((c) => { for (let g = c.group?.parent; g; g = g.parent) if (g.id === from) return [c.group.id]; return []; }))];
    if (inner.length) throw new EditError(`group '${from}' cannot be rebuilt while its inner group${inner.length > 1 ? "s" : ""} ${inner.map((i) => `'${i}'`).join(", ")} ${inner.length > 1 ? "are" : "is"} still expanded`, "inner_expanded",
      `make_compound from=${inner[0]} first (rebuild inner groups before outer ones)`);
    const home = found[0].c.group.track, rank = (f: { tr: Track }) => (f.tr.id === home ? 0 : 1); // stamps are written together; if they disagreed, the first wins
    if (!tl.tracks.some((t) => t.id === home))
      throw new EditError(`group '${from}' was expanded onto track '${home}', which no longer exists`, "missing_track", `recreate it (add_track id=${home}), or regroup by hand with ids`);
    if (!found.some((f) => f.tr.id === home))
      throw new EditError(`none of group '${from}' is on its home track '${home}' any more`, "home_track_empty", `move the clips back to '${home}', or regroup by hand with ids (the first id picks the track)`);
    return { ids: found.map((f, i) => ({ f, i })).sort((x, y) => rank(x.f) - rank(y.f) || x.i - y.i).map((x) => x.f.c.id), name: found.find((f) => f.c.group.name)?.c.group.name,
      parent: found.find((f) => f.c.group.parent)?.c.group.parent }; // the outer group the rebuilt compound rejoins; members were stamped together, so if they disagreed the first wins
  };

  h.op("make_compound", "Group clips into one compound clip (Final Cut compound clip / CapCut group) that moves, trims, fades and gets effects as one " +
    "layer. Nested tracks mirror the source tracks; the compound goes where the first listed clip was (selected clips on a magnetic track must be " +
    "contiguous; there the selection must not extend before/after them). Other magnetic tracks keep their timing with a gap; clips outside the " +
    "selection attached to selected clips are detached (reported). Undo with expand_compound. `from` regroups an expanded compound: it takes every " +
    "top-level clip and gap that expand_compound stamped with that compound id (field group; it survives split_clip), gives the compound that id and " +
    "name, and clears the stamps. Rebuild inner groups first (inner_expanded otherwise).",
    { ids: "clip ids or refs like 'main#1' (first one picks the track); or use from", from: "id of an expanded compound: regroup the clips its expand_compound stamped (instead of ids)",
      id: "compound id (auto cmpN; with from: that id)", name: "label (with from: the compound's old name)" }, (p, tl, a) => {
      resolve(tl);
      const refs: unknown[] = Array.isArray(a.ids) ? a.ids : typeof a.ids === "string" ? a.ids.split(",") : [];
      if (a.from !== undefined && refs.length) throw new EditError("pass either 'ids' or 'from', not both", "bad_arg", "ids groups the clips you list; from regroups an expanded compound");
      if (a.from === undefined && !refs.length) throw new EditError("missing 'ids' or 'from'", "missing_arg", "ids: [clip ids or refs like 'main#1'], at least one; or from: the id of an expanded compound");
      let regroup: { ids: string[]; name?: string; parent?: Clip } | undefined;
      if (a.from !== undefined) {
        const from = String(a.from);
        if ([...allClips(tl.tracks)].some((c) => c.id === from)) throw new EditError(`id '${from}' is already used on the timeline`, "exists", `if '${from}' is a compound, expand_compound it first; otherwise pass ids`);
        regroup = stampedIds(tl, from);
        a = { ...a, id: a.id ?? from, name: a.name ?? regroup.name };
      }
      const ids = [...new Set((regroup?.ids ?? refs.map(String)).map((r) => h.resolveRef(tl, r.trim())))];
      const picked = ids.map((id) => findClip(tl, id)[2]), sel = new Set(ids);
      const home = findClip(tl, ids[0])[0];
      if (a.id && (tl.tracks.some((t) => t.id === a.id) || [...allClips(tl.tracks)].some((c) => c.id === a.id))) throw new EditError(`id '${a.id}' already exists`, "exists");
      const s0 = Math.min(...picked.map(clipStart)), e0 = Math.max(...picked.map(clipEnd));
      const cmp: Clip = { id: a.id || newId(tl, "cmp"), type: "compound", ...(a.name ? { name: a.name } : {}), duration: round6(e0 - s0), tracks: [] };
      if (regroup?.parent) cmp.group = structuredClone(regroup.parent);
      const gaps: Clip[] = [], lost: string[] = [];
      for (const tr of tl.tracks) {
        const idx = tr.clips.flatMap((c, i) => (sel.has(c.id) ? [i] : []));
        if (!idx.length) continue;
        const i0 = idx[0], i1 = idx[idx.length - 1];
        if (tr.magnetic && i1 - i0 + 1 !== idx.length)
          throw new EditError(`selected clips on magnetic track '${tr.id}' are not contiguous`, "not_contiguous", `select a contiguous run, e.g. ${tr.clips.slice(i0, i1 + 1).map((c) => c.id).join(", ")}`);
        const clips = idx.map((i) => {
          const n = structuredClone(tr.clips[i]);
          n.start = round6(clipStart(n) - s0);
          delete n.until_end; delete n.group;
          if (tr.magnetic || (n.attach_to && !sel.has(n.attach_to))) detach(n);
          return n;
        });
        if (clips[0].transition) { lost.push(clips[0].id); delete clips[0].transition; } // first nested clip has no previous clip
        const nt: Track = { id: tr.id, kind: tr.kind ?? "video", clips };
        for (const k of TRACK_PROPS) if (tr[k] !== undefined) nt[k] = tr[k];
        cmp.tracks.push(nt);
        if (!tr.magnetic) { tr.clips = tr.clips.filter((c) => !sel.has(c.id)); continue; }
        // magnetic: replace the run with the compound (home) or a gap, keeping everything after it in place
        const first = tr.clips[i0], sIn = clipStart(first), eOut = clipEnd(tr.clips[i1]), prevEnd = i0 ? clipEnd(tr.clips[i0 - 1]) : 0;
        pin(tr.clips[i1 + 1], eOut - clipStart(tr.clips[i1 + 1] ?? first));
        let rep: Clip;
        if (tr === home) {
          if (Math.abs(sIn - s0) > 1e-4 || Math.abs(eOut - e0) > 1e-4)
            throw new EditError(`the selection spans ${s0.toFixed(2)}–${e0.toFixed(2)}s but its clips on magnetic track '${tr.id}' span ${sIn.toFixed(2)}–${eOut.toFixed(2)}s`,
              "out_of_span", `on a storyline the compound replaces those clips exactly: only add clips inside ${sIn.toFixed(2)}–${eOut.toFixed(2)}s, or list a clip on a non-magnetic track first`);
          rep = cmp;
          if (first.transition && prevEnd - sIn > EPS) { cmp.transition = { ...normAnim(first.transition, 0.5)!, duration: round6(prevEnd - sIn) }; lost.splice(lost.indexOf(first.id), 1); }
        } else gaps.push((rep = gap(eOut - prevEnd)));
        tr.clips.splice(i0, idx.length, rep);
      }
      if (!home.magnetic) { cmp.start = round6(s0); home.clips.push(cmp); home.clips.sort((x, y) => clipStart(x) - clipStart(y)); }
      fillGaps(tl, gaps);
      const detached: string[] = [];
      for (const [, , , c] of iterClips(tl)) if (c.attach_to && sel.has(c.attach_to)) { detach(c); detached.push(c.id); }
      resolve(tl);
      return { id: cmp.id, track: home.id, start: cmp.start, duration: cmp.duration, clips: ids, tracks: cmp.tracks.map((t: Track) => t.id),
        detached, gaps: gaps.map((g) => g.id), ...(lost.length ? { dropped_transitions: lost } : {}) };
    });

  h.op("expand_compound", "Break a compound clip apart: its nested clips go back onto the same-id tracks (created if missing) at their current " +
    "timeline positions, trimmed to the visible part (in/duration). On the compound's magnetic track they are spliced in its place (gaps fill holes). " +
    "Every clip and gap it places gets a `group` stamp {id, name, track, parent?} (parent = the stamp the expanded compound itself carried); make_compound from=<id> regroups them, and the rebuilt compound takes that parent stamp back. Needs speed 1.", { id: "compound clip id or ref" }, (p, tl, a) => {
      resolve(tl);
      const [home, ci, c] = findClip(tl, h.resolveRef(tl, String(a.id ?? "")));
      if (c.type !== "compound") throw new EditError(`'${c.id}' is a ${c.type} clip, not a compound`, "bad_type", "pass the id of a compound clip (see info)");
      if (Math.abs((Number(c.speed ?? 1) || 1) - 1) > EPS || c.keyframes?.speed)
        throw new EditError(`'${c.id}' plays at a different speed; expand_compound needs speed 1`, "retimed", `reset it first: update_clip id=${c.id} set={speed: null}`);
      const w0 = parseTime(c.in ?? 0), dur = clipDur(c), base = clipStart(c), next = home.clips[ci + 1];
      if (home.magnetic) pin(next, base + dur - clipStart(next ?? c));
      home.clips.splice(ci, 1);
      const placed = new Map<string, Clip>(), dropped: string[] = [], created: string[] = [], gaps: Clip[] = [];
      const stamp = () => ({ id: c.id, ...(c.name ? { name: c.name } : {}), track: home.id, ...(c.group ? { parent: structuredClone(c.group) } : {}) }); // make_compound from=<id> regroups what carries it
      const lists: [Track, Clip[]][] = [];
      for (const nt of (c.tracks ?? []) as Track[]) {
        const clips: Clip[] = [];
        for (const n0 of nt.clips) {
          const s = clipStart(n0), e = s + clipDur(n0), x0 = Math.max(s, w0), x1 = Math.min(e, w0 + dur);
          if (x1 - x0 < 1e-3) { dropped.push(n0.id); continue; }
          const n = structuredClone(n0);
          trim(n, x0 - s, e - x1);
          n.group = stamp();
          n.start = round6(base + x0 - w0);
          clips.push(n); placed.set(n.id, n);
        }
        if (clips.length) lists.push([nt, clips.sort((x, y) => clipStart(x) - clipStart(y))]);
      }
      // connected clips keep their position relative to (possibly trimmed) targets; targets that did not come back -> detach
      for (const n of placed.values()) {
        if (!n.attach_to) continue;
        const t = placed.get(n.attach_to);
        if (!t) { detach(n); continue; }
        const off = (n.offset = round6(clipStart(n) - clipStart(t)));
        if (n.match_duration) { const eo = round6(clipDur(t) - off - clipDur(n)); if (eo < -EPS) { delete n.match_duration; delete n.end_offset; } else n.end_offset = eo; }
      }
      for (const [nt, clips] of lists) {
        let tr = tl.tracks.find((t) => t.id === nt.id);
        if (tr === home && home.magnetic) { // splice into the storyline; starts become implicit
          const seq: Clip[] = [];
          let cur = base;
          for (const n of clips) {
            const st = clipStart(n);
            const g = st > cur + 1e-3 ? gap(st - cur) : null;
            if (g) { gaps.push(g); seq.push(g); cur = st; delete n.transition; }
            else if (seq.length) pin(n, cur - st); // an overlap with the previous clip is its transition
            else if (c.transition) n.transition = structuredClone(c.transition); else delete n.transition;
            const eff = !g && seq.length && n.transition ? st : cur;
            delete n.start; detach(n); seq.push(n);
            cur = eff + clipDur(n);
          }
          if (cur < base + dur - 1e-3) { gaps.push(gap(base + dur - cur)); seq.push(gaps[gaps.length - 1]); }
          home.clips.splice(ci, 0, ...seq);
          continue;
        }
        if (tr?.magnetic) tr = undefined; // absolute starts cannot go onto another storyline: use a new track
        if (!tr) {
          const id = tl.tracks.some((t) => t.id === nt.id) ? newId(tl, `${nt.id}_`) : nt.id;
          tr = h.ensureTrack(tl, id, nt.kind === "audio" ? "audio" : "video");
          for (const k of TRACK_PROPS) if (nt[k] !== undefined) tr[k] = structuredClone(nt[k]);
          created.push(id);
        }
        tr.clips.push(...clips);
        tr.clips.sort((x, y) => clipStart(x) - clipStart(y));
      }
      for (const g of gaps) g.group = stamp();
      fillGaps(tl, gaps);
      const detached: string[] = [];
      for (const [, , , x] of iterClips(tl)) if (x.attach_to === c.id) { detach(x); detached.push(x.id); }
      resolve(tl);
      return { expanded: c.id, ids: [...placed.keys()], gaps: gaps.map((g) => g.id), dropped, created_tracks: created, detached };
    });
}
