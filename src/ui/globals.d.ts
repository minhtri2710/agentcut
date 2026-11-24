/** the keyframe enums of src/model.ts, substituted by scripts/build-ui.ts when the page is bundled */
declare const ENUM: { animatable: string[]; easings: string[] };
/** the inspector form's tables from src/model.ts (scripts/build-ui.ts FORM): section -> field -> [json types, doc]; clip type -> [section, keys][]; field -> values; grade [key, doc][] */
declare const FORM: {
  fields: Record<string, Record<string, [string[], string]>>;
  types: Record<string, [string, string[]][]>;
  enums: Record<string, string[]>;
  grade: [string, string][];
};
