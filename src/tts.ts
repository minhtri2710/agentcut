// Text-to-speech providers besides the OS voice: piper (local neural TTS) and OpenAI-compatible HTTP /v1/audio/speech.
// Selected by voice prefix ("piper", "piper:/m.onnx", "openai:nova", "system:Linh") or AGENTCUT_TTS_PROVIDER.
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { basename, delimiter, extname, join } from "node:path";
import { EditError, ORT_ENV } from "./model.ts";
import { createFile } from "./safe-write.ts";

export const PROVIDERS = ["system", "piper", "openai"] as const;
export type Provider = (typeof PROVIDERS)[number];
type Env = Record<string, string | undefined>;
const NORMAL_WPM = 175; // `rate` is words/min like macOS say; other engines get a speed factor relative to this
export const OPENAI_VOICES = ["alloy", "ash", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer"];

/** Is `f` an executable file? A lookup only: it is never started. */
export function isExecutable(f: string): boolean {
  try { accessSync(f, constants.X_OK); return statSync(f).isFile(); } catch { return false; }
}

/** Is `bin` an executable file on PATH? A lookup only: the binary is never started. On Windows, the names a spawn without a shell resolves: bin as given when it has an extension, else bin.com and bin.exe. */
export function has(bin: string): boolean {
  const exts = process.platform === "win32" ? (extname(bin) ? ["", ".com", ".exe"] : [".com", ".exe"]) : [""];
  return (process.env.PATH || "").split(delimiter).some((dir) => dir && exts.some((e) => isExecutable(join(dir, bin + e))));
}

export function pickProvider(voice?: string, env: Env = process.env): { provider: Provider; voice?: string } {
  const m = /^(system|piper|openai)(?::(.*))?$/s.exec(voice ?? "");
  if (m) return { provider: m[1] as Provider, voice: m[2] || undefined };
  const d = env.AGENTCUT_TTS_PROVIDER || "system";
  if (!(PROVIDERS as readonly string[]).includes(d)) throw new EditError(`unknown TTS provider '${d}' in AGENTCUT_TTS_PROVIDER`, "bad_voice", `providers: ${PROVIDERS.join(", ")}`);
  return { provider: d as Provider, voice };
}

/** Speech endpoint: AGENTCUT_TTS_URL (base like http://host/v1 or the full .../audio/speech), or OpenAI when only a key is set. */
export function speechUrl(env: Env = process.env): string | null {
  const u = env.AGENTCUT_TTS_URL?.replace(/\/+$/, "");
  if (!u) return env.AGENTCUT_TTS_KEY ? "https://api.openai.com/v1/audio/speech" : null;
  return u.endsWith("/audio/speech") ? u : u.endsWith("/v1") ? `${u}/audio/speech` : `${u}/v1/audio/speech`;
}

export function speechBody(text: string, voice?: string, rate?: number, env: Env = process.env) {
  return {
    model: env.AGENTCUT_TTS_MODEL || "tts-1", input: text, voice: voice || env.AGENTCUT_TTS_VOICE || "alloy", response_format: "wav",
    ...(rate ? { speed: +Math.min(4, Math.max(0.25, rate / NORMAL_WPM)).toFixed(3) } : {}),
  };
}

/** POST via curl (ops are synchronous). The key goes through curl's stdin config, never argv or logs. Returns the audio path. */
export function httpSpeech(text: string, dir: string, voice?: string, rate?: number, env: Env = process.env): string {
  const url = speechUrl(env);
  if (!url) throw new EditError("HTTP TTS is not configured", "missing_dependency", "set AGENTCUT_TTS_URL (OpenAI-compatible base, e.g. http://localhost:8880/v1) and/or AGENTCUT_TTS_KEY; optional AGENTCUT_TTS_MODEL, AGENTCUT_TTS_VOICE");
  if (!has("curl")) throw new EditError("HTTP TTS needs curl", "missing_dependency", "install curl");
  const body = join(dir, "req.json"), out = join(dir, "tts-http.wav");
  createFile(body, JSON.stringify(speechBody(text, voice, rate, env)));
  const key = env.AGENTCUT_TTS_KEY;
  const cfg = key ? `header = "Authorization: Bearer ${key.replace(/[\\"]/g, "\\$&")}"\n` : "";
  const r = spawnSync("curl", ["-sS", "-K", "-", "-X", "POST", url, "-H", "Content-Type: application/json", "--data-binary", `@${body}`,
    "-o", out, "-w", "%{http_code}", "--max-time", "300"], { input: cfg, encoding: "utf8" });
  const code = Number(r.stdout);
  if (r.status !== 0 || code < 200 || code >= 300) {
    const detail = existsSync(out) ? readFileSync(out, "utf8").slice(0, 300) : String(r.stderr || r.error || "").slice(0, 300);
    throw new EditError(`HTTP TTS failed (${code || "no response"} from ${url}): ${detail}`, "tts_failed", "check AGENTCUT_TTS_URL / AGENTCUT_TTS_KEY / model / voice");
  }
  return out;
}

/** piper reads text on stdin and writes a WAV. voice = a model .onnx path, else AGENTCUT_PIPER_MODEL. */
export function piperSpeech(text: string, dir: string, voice?: string, rate?: number, env: Env = process.env): string {
  const model = voice || env.AGENTCUT_PIPER_MODEL;
  if (!model || !existsSync(model)) throw new EditError(`piper model ${model ? `'${model}' not found` : "not set"}`, "missing_dependency", "set AGENTCUT_PIPER_MODEL=/path/voice.onnx (with its .onnx.json) or use voice 'piper:/path/voice.onnx'");
  if (!has("piper")) throw new EditError("piper not installed", "missing_dependency", "install piper (`pip install piper-tts` or a release binary) and put `piper` on PATH");
  const out = join(dir, "tts-piper.wav");
  const r = spawnSync("piper", ["--model", model, "--output_file", out, ...(rate ? ["--length_scale", (NORMAL_WPM / rate).toFixed(3)] : [])], { input: text, encoding: "utf8", env: { ...process.env, ...ORT_ENV } });
  if (r.status !== 0 || !existsSync(out)) throw new EditError(`piper failed: ${String(r.stderr || r.error).slice(0, 300)}`, "tts_failed");
  return out;
}

const piperLang = (model: string) => { try { return JSON.parse(readFileSync(`${model}.json`, "utf8")).language?.code ?? "unknown"; } catch { return "unknown"; } };

/** Providers usable right now (no secrets: only whether a key is set) and their voices. */
export function providerInfo(env: Env = process.env) {
  const model = env.AGENTCUT_PIPER_MODEL, url = speechUrl(env);
  const piperOk = !!model && existsSync(model) && has("piper"), httpOk = !!url;
  return {
    providers: [
      { name: "piper", available: piperOk, ...(piperOk ? { model } : { hint: "needs `piper` on PATH + AGENTCUT_PIPER_MODEL=/path/voice.onnx" }) },
      { name: "openai", available: httpOk, ...(httpOk ? { url, model: env.AGENTCUT_TTS_MODEL || "tts-1", key: env.AGENTCUT_TTS_KEY ? "set" : "unset" } : { hint: "set AGENTCUT_TTS_URL (OpenAI-compatible) and/or AGENTCUT_TTS_KEY" }) },
    ],
    voices: [
      ...(piperOk ? [{ name: "piper", provider: "piper", full_name: basename(model!), lang: piperLang(model!), sample: "piper local model" }] : []),
      ...(httpOk ? OPENAI_VOICES.map((v) => ({ name: `openai:${v}`, provider: "openai", lang: "multi", sample: "OpenAI-compatible /audio/speech (server may offer other voices)" })) : []),
    ],
  };
}
