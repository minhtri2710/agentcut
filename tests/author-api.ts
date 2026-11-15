// The api namespace the suites import: apply, prepare, undo and redo carry the author "test" unless a call names its own (the history rows do).
// The real src/api.ts has no default author: a call without one is missing_author (tests/edit-ops.ts).
// The revision is not bound here: every call passes its own (threaded from the previous result, or a suite's visibly named applyLatest), as an agent must.
import * as real from "../src/api.ts";

export * from "../src/api.ts";

export const TEST_AUTHOR = "test";
export const apply = (project: string | undefined, ops: Parameters<typeof real.apply>[1], o: Parameters<typeof real.apply>[2]) => real.apply(project, ops, { author: TEST_AUTHOR, ...o });
export const prepare = (project?: string, o: Parameters<typeof real.prepare>[1] = {}) => real.prepare(project, { author: TEST_AUTHOR, ...o });
export const undo = (project: string | undefined, steps: number, revision: number | undefined, author = TEST_AUTHOR) => real.undo(project, steps, revision, author);
export const redo = (project: string | undefined, steps: number, revision: number | undefined, author = TEST_AUTHOR) => real.redo(project, steps, revision, author);
