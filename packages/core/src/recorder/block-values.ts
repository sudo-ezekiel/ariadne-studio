// The values a BA sets on a setup block for one case: which test user a log
// in block uses, which policy number a search block types. Pure and free of
// Node imports so the studio UI uses the same rules as the server.
//
// A value is either a reference to a saved value, `${KEY}` with KEY in the
// project's .env or project.json env, or plain text. Plain text is written
// into the case file and the flow, so it is refused for anything that looks
// like a secret; secrets only ever travel as references.
//
// Only variables the block does not give a default in its own `env:` header
// can be set. Maestro keeps a block's header default over a value passed to
// its runFlow, while agent-device takes the passed value, so for a variable
// with a header default the recording and the run would type different text
// (checked with Maestro 2.12 and agent-device 0.21.35 on 2026-11-02).

/** Variable names that hold secrets: their values must be saved values, never typed into a case. */
const SECRET_NAME = /(PASS|PWD|SECRET|TOKEN|PIN|OTP|API_?KEY|PRIVATE)/i;
const REFERENCE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_TEXT = 200;

export type BlockValues = Record<string, string>;

export function isSecretName(name: string): boolean {
  return SECRET_NAME.test(name);
}

/** The KEY of a `${KEY}` value, else undefined for plain text. */
export function referencedKey(value: string): string | undefined {
  return REFERENCE.exec(value)?.[1];
}

export function reference(key: string): string {
  return `\${${key}}`;
}

/** "SUPERVISOR" -> "Supervisor", "AGENT_MARIA" -> "Agent Maria". */
function label(prefix: string): string {
  return prefix
    .split('_')
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

export type TestUser = { prefix: string; label: string; values: BlockValues };

/** A test user's name as the prefix of its saved values: "Agent Maria" -> "AGENT_MARIA"; undefined when unusable. */
export function testUserPrefix(name: string): string | undefined {
  const prefix = name
    .trim()
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  return /^[A-Z][A-Z0-9_]{0,39}$/.test(prefix) ? prefix : undefined;
}

/**
 * The test users a block can run as: every prefix P for which the project
 * has a saved value P_V for each of the block's variables V. A log in block
 * using USERNAME and PASSWORD runs as "Supervisor" when SUPERVISOR_USERNAME
 * and SUPERVISOR_PASSWORD are saved.
 */
export function testUsers(variables: readonly string[], envKeys: readonly string[]): TestUser[] {
  if (variables.length === 0) return [];
  const keys = new Set(envKeys);
  const prefixes = new Set<string>();
  const first = variables[0]!;
  for (const key of envKeys) {
    if (key.endsWith(`_${first}`) && key.length > first.length + 1) prefixes.add(key.slice(0, -first.length - 1));
  }
  return [...prefixes]
    .filter((prefix) => variables.every((variable) => keys.has(`${prefix}_${variable}`)))
    .sort()
    .map((prefix) => ({
      prefix,
      label: label(prefix),
      values: Object.fromEntries(variables.map((variable) => [variable, reference(`${prefix}_${variable}`)])),
    }));
}

/** The test user these values amount to, when every value is that user's saved value. */
export function matchingTestUser(values: BlockValues | undefined): TestUser | undefined {
  const entries = Object.entries(values ?? {});
  if (entries.length === 0) return undefined;
  let prefix: string | undefined;
  for (const [variable, value] of entries) {
    const key = referencedKey(value);
    if (!key || !key.endsWith(`_${variable}`)) return undefined;
    const candidate = key.slice(0, -variable.length - 1);
    if (!candidate || (prefix !== undefined && candidate !== prefix)) return undefined;
    prefix = candidate;
  }
  return prefix ? { prefix, label: label(prefix), values: { ...values } } : undefined;
}

/** How the values read in a step list or document: "as Supervisor", or each value with where it comes from. */
export function describeValues(values: BlockValues | undefined): string | undefined {
  const entries = Object.entries(values ?? {});
  if (entries.length === 0) return undefined;
  const user = matchingTestUser(values);
  if (user) return `as ${user.label}`;
  const parts = entries.map(([variable, value]) => {
    const key = referencedKey(value);
    return key ? `${variable} from ${key}` : `${variable} "${value}"`;
  });
  return `with ${parts.join(', ')}`;
}

/**
 * Why these values cannot be used on a block whose settable variables are
 * `settable`, or undefined when they can. Callers pass values through
 * normalizeValues first.
 */
export function checkValues(values: BlockValues, settable: readonly string[], envKeys: readonly string[]): string | undefined {
  const keys = new Set(envKeys);
  for (const [variable, value] of Object.entries(values)) {
    if (!KEY.test(variable)) return `"${variable}" is not a variable name.`;
    if (!settable.includes(variable)) return `This block has no setting called ${variable}.`;
    const key = referencedKey(value);
    if (key) {
      if (!keys.has(key)) return `There is no saved value called ${key} for ${variable}.`;
      continue;
    }
    if (isSecretName(variable)) return `${variable} looks like a secret, so it must come from a saved value, not typed text.`;
    if (value.includes('${')) return `The value of ${variable} can be a saved value such as \${KEY} or plain text, not a mix.`;
    if (/[\r\n]/.test(value) || value.length > MAX_TEXT) return `The value of ${variable} must be one line of at most ${MAX_TEXT} characters.`;
  }
  return undefined;
}

/**
 * Drops empty values, and turns plain text that is exactly a saved value
 * into a reference to it, the way typing a saved value records `${KEY}`, so
 * a secret pasted as text never reaches the case file.
 */
export function normalizeValues(values: BlockValues | undefined, env: Readonly<Record<string, string>>): BlockValues | undefined {
  const result: BlockValues = {};
  for (const [variable, raw] of Object.entries(values ?? {})) {
    if (raw === '') continue;
    const saved = referencedKey(raw) ? undefined : Object.entries(env).find(([, value]) => value.length >= 4 && value === raw)?.[0];
    result[variable] = saved ? reference(saved) : raw;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** The values to run the block with now, references replaced by what they refer to. */
export function resolveValues(values: BlockValues | undefined, env: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values ?? {}).map(([variable, value]) => {
      const key = referencedKey(value);
      return [variable, key ? (env[key] ?? '') : value];
    }),
  );
}
