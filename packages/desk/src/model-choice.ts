import type { Model } from "@earendil-works/pi-ai";

/** A model, or where to find the one chosen now: it can change between runs (Admin → Models on the website). */
export type ModelChoice = Model<any> | (() => Model<any> | undefined);

export const pickModel = (m: ModelChoice | undefined): Model<any> | undefined => (typeof m === "function" ? m() : m);
