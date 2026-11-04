// Maestro treats every `text` and `id` selector as a regular expression that
// must match the whole attribute. Literal values from the snapshot therefore
// need their metacharacters escaped, or "Display (beta)" would look for a
// capture group and never match.
const MAESTRO_REGEX_META = /[.*+?^${}()|[\]\\]/g;

export function escapeMaestroRegex(value: string): string {
  return value.replace(MAESTRO_REGEX_META, '\\$&');
}

/** Inverse of escapeMaestroRegex, used when showing parsed selectors to a person. */
export function unescapeMaestroRegex(value: string): string {
  return value.replace(/\\([.*+?^${}()|[\]\\])/g, '$1');
}
