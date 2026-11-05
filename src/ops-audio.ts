// Audio ops: enhance_voice (one-shot voice chain on a clip or a whole track).
import { AUDIO_FX_KEYS, DENOISE_STRENGTH } from "./audiofx.ts";
import { type Dict, EditError, findClip, findTrack } from "./model.ts";
import { linkedAudio, type OpHelpers } from "./ops.ts";


export function registerAudioOps(h: OpHelpers) {
  h.op("enhance_voice", "Clean up speech in one step: denoise (noise floor measured per clip) + high-pass 80 Hz + voice-clarity EQ + de-ess + voice compressor, " +
    "and normalize (-16 LUFS) per clip. id: a video/audio clip (a video with detached audio enhances that audio clip), or track: every clip on it " +
    "(e.g. track='voice'). Overwrites those fields; tweak them afterwards with update_clip/update_track. strength 0..1 scales the denoise.",
    { id: "clip id or ref ('main#0')", track: "track id (instead of id)", strength: `denoise 0..1 (${DENOISE_STRENGTH})` }, (p, tl, a) => {
      if ((a.id === undefined) === (a.track === undefined)) throw new EditError("enhance_voice needs exactly one of 'id' or 'track'", "missing_arg", "e.g. {op:'enhance_voice', track:'voice'} or {op:'enhance_voice', id:'aud1'}");
      const strength = a.strength ?? DENOISE_STRENGTH;
      if (typeof strength !== "number" || strength < 0 || strength > 1) throw new EditError("strength must be a number 0..1", "bad_arg", "0.5 is a good default; 1 = strongest noise removal");
      const chain: Dict = { denoise: strength, eq: ["voice_clarity", "de_ess"], compressor: "voice", normalize: true };
      if (a.track !== undefined) {
        const tr = findTrack(tl, a.track);
        // the track carries the chain: per-clip parts apply to every clip, eq/compressor process the track mix once
        for (const k of AUDIO_FX_KEYS) delete tr[k];
        Object.assign(tr, chain);
        return { track: tr.id, set: chain, clips: tr.clips.filter((c) => c.type === "audio" || c.type === "video").map((c) => c.id) };
      }
      let [, , c] = findClip(tl, h.resolveRef(tl, String(a.id)));
      if (c.type !== "audio" && c.type !== "video") throw new EditError(`enhance_voice needs a video or audio clip; '${c.id}' is ${c.type}`, "bad_type");
      const la = linkedAudio(tl, c);
      if (la) c = la[1];
      else if (c.muted) throw new EditError(`'${c.id}' is muted, so there is no audio to enhance`, "muted", `unmute it first: update_clip id=${c.id} muted=false`);
      if (c.type === "video" && !tl.assets[c.asset]?.has_audio) throw new EditError(`'${c.id}' has no audio stream`, "no_audio");
      Object.assign(c, chain);
      return { id: c.id, set: chain };
    });
}
