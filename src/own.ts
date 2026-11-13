// A name given by a caller (an op, template, preset, asset id, codec...) is looked up among a table's own entries:
// `constructor` and `toString` are inherited, not entries. A leaf module: model.ts, color.ts and audiofx.ts all use it.
export const own = <T>(table: Record<string, T>, key: unknown): T | undefined => (Object.hasOwn(table, key as string) ? table[key as string] : undefined);
