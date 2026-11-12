export type Snapshot = Record<string, string>;
/** A file's new text, or null to delete it. */
export type Changes = Record<string, string | null>;
