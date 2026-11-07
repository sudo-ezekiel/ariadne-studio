// The rules for the values a BA sets on a setup block: which names are secrets,
// how a test user is named and found, how values read in a step list, what is
// refused, and how pasted saved values turn into references.
import { describe, expect, it } from 'vitest';
import {
  checkValues,
  describeValues,
  isSecretName,
  matchingTestUser,
  normalizeValues,
  passwordSetting,
  reference,
  referencedKey,
  resolveValues,
  testUserPrefix,
  testUsers,
} from '../src/recorder/block-values.ts';

describe('isSecretName', () => {
  it('flags names that hold secrets', () => {
    for (const name of ['PASSWORD', 'PIN', 'API_KEY', 'APIKEY', 'TOKEN', 'ACCESS_TOKEN', 'CLIENT_SECRET', 'PWD', 'OTP', 'PRIVATE_KEY', 'SUPERVISOR_PASSWORD']) {
      expect(isSecretName(name), name).toBe(true);
    }
  });

  it('ignores case', () => {
    for (const name of ['password', 'Password', 'pin', 'api_key', 'Token']) {
      expect(isSecretName(name), name).toBe(true);
    }
  });

  it('leaves ordinary settings alone', () => {
    for (const name of ['USERNAME', 'COUNTRY', 'POLICY_NUMBER', 'CLAIM_REFERENCE', 'SEARCH_TEXT', 'EMAIL', 'LAST_NAME']) {
      expect(isSecretName(name), name).toBe(false);
    }
  });
});

describe('referencedKey and reference', () => {
  it('reads the KEY of a ${KEY} value', () => {
    expect(referencedKey('${USERNAME}')).toBe('USERNAME');
    expect(referencedKey('${_a1}')).toBe('_a1');
  });

  it('is undefined for anything that is not exactly one reference', () => {
    for (const value of ['', 'USERNAME', '${}', '${1A}', '${A-B}', '${A.b}', 'x${A}', '${A}x', ' ${A}', '${A} ', '${A}\n', '${A}${B}', '$A', '{A}']) {
      expect(referencedKey(value), JSON.stringify(value)).toBeUndefined();
    }
  });

  it('builds a reference that referencedKey reads back', () => {
    expect(reference('AGENT_USERNAME')).toBe('${AGENT_USERNAME}');
    expect(referencedKey(reference('AGENT_USERNAME'))).toBe('AGENT_USERNAME');
  });
});

describe('testUserPrefix', () => {
  it('turns a name into the prefix of its saved values', () => {
    expect(testUserPrefix('Supervisor')).toBe('SUPERVISOR');
    expect(testUserPrefix('Agent Maria')).toBe('AGENT_MARIA');
    expect(testUserPrefix('agent maria')).toBe('AGENT_MARIA');
  });

  it('trims, and collapses runs of other characters into one underscore', () => {
    expect(testUserPrefix('  Agent   Maria  ')).toBe('AGENT_MARIA');
    expect(testUserPrefix('agent-maria.2')).toBe('AGENT_MARIA_2');
    expect(testUserPrefix('Agent (Maria)')).toBe('AGENT_MARIA');
    expect(testUserPrefix('A__B')).toBe('A_B');
    expect(testUserPrefix('_lead_')).toBe('LEAD');
    expect(testUserPrefix('Agent 2')).toBe('AGENT_2');
  });

  it('is undefined for a name that does not start with a letter', () => {
    expect(testUserPrefix('1st')).toBeUndefined();
    expect(testUserPrefix('2 agents')).toBeUndefined();
    expect(testUserPrefix('!!!')).toBeUndefined();
    expect(testUserPrefix('')).toBeUndefined();
    expect(testUserPrefix('   ')).toBeUndefined();
  });

  it('is undefined for a name with no Latin letters at all', () => {
    expect(testUserPrefix('Μαρία')).toBeUndefined();
  });

  it('allows at most 40 characters', () => {
    expect(testUserPrefix('A'.repeat(40))).toBe('A'.repeat(40));
    expect(testUserPrefix('A'.repeat(41))).toBeUndefined();
    // The underscore that replaces a space counts toward the 40.
    expect(testUserPrefix(`${'A'.repeat(38)} B`)).toBe(`${'A'.repeat(38)}_B`);
    expect(testUserPrefix(`${'A'.repeat(39)} B`)).toBeUndefined();
  });

  it('gives a prefix that is itself a valid start of a saved value name', () => {
    for (const name of ['Supervisor', 'Agent Maria', 'qa-2 user']) {
      const prefix = testUserPrefix(name)!;
      expect(`${prefix}_USERNAME`).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
    }
  });
});

describe('testUsers', () => {
  const variables = ['USERNAME', 'PASSWORD'];

  it('offers a prefix when every variable has a saved value with it', () => {
    const users = testUsers(variables, ['SUPERVISOR_USERNAME', 'SUPERVISOR_PASSWORD']);
    expect(users).toEqual([
      {
        prefix: 'SUPERVISOR',
        label: 'Supervisor',
        values: { USERNAME: '${SUPERVISOR_USERNAME}', PASSWORD: '${SUPERVISOR_PASSWORD}' },
      },
    ]);
  });

  it('labels a prefix with several words', () => {
    const [user] = testUsers(variables, ['AGENT_MARIA_USERNAME', 'AGENT_MARIA_PASSWORD']);
    expect(user).toMatchObject({ prefix: 'AGENT_MARIA', label: 'Agent Maria' });
  });

  it('skips a prefix that is missing a value for one of the variables', () => {
    expect(testUsers(variables, ['SUPERVISOR_USERNAME'])).toEqual([]);
    expect(testUsers(variables, ['SUPERVISOR_PASSWORD'])).toEqual([]);
    expect(testUsers(variables, ['SUPERVISOR_USERNAME', 'SUPERVISOR_PASSWORD', 'AGENT_USERNAME'])).toHaveLength(1);
  });

  it('sorts the users by prefix whatever the order of the keys', () => {
    const keys = ['SUPERVISOR_USERNAME', 'SUPERVISOR_PASSWORD', 'AGENT_MARIA_PASSWORD', 'AGENT_MARIA_USERNAME', 'ADMIN_USERNAME', 'ADMIN_PASSWORD'];
    expect(testUsers(variables, keys).map((user) => user.label)).toEqual(['Admin', 'Agent Maria', 'Supervisor']);
    expect(testUsers(variables, [...keys].reverse()).map((user) => user.label)).toEqual(['Admin', 'Agent Maria', 'Supervisor']);
  });

  it('works for a block with one variable', () => {
    const users = testUsers(['USERNAME'], ['AGENT_USERNAME', 'SUPERVISOR_USERNAME', 'SUPERVISOR_PASSWORD']);
    expect(users.map((user) => user.prefix)).toEqual(['AGENT', 'SUPERVISOR']);
  });

  it('has nobody to offer without variables or without saved values', () => {
    expect(testUsers([], ['SUPERVISOR_USERNAME'])).toEqual([]);
    expect(testUsers(variables, [])).toEqual([]);
  });

  it('does not count a bare saved value as a prefixed one', () => {
    expect(testUsers(variables, ['USERNAME', 'PASSWORD'])).toEqual([]);
    expect(testUsers(variables, ['_USERNAME', '_PASSWORD'])).toEqual([]);
  });

  it('does not take a longer name for the variable', () => {
    // A_USER_NAME ends with _NAME, but only the exact variable names count.
    expect(testUsers(['NAME', 'USER_NAME'], ['A_NAME', 'A_USER_NAME']).map((user) => user.prefix)).toEqual(['A']);
    expect(testUsers(['USERNAME'], ['SUPERVISOR_ADMINUSERNAME'])).toEqual([]);
    expect(testUsers(['USERNAME'], ['SUPERVISORUSERNAME'])).toEqual([]);
  });

  it('gives values that matchingTestUser recognises as the same user', () => {
    const [user] = testUsers(variables, ['SUPERVISOR_USERNAME', 'SUPERVISOR_PASSWORD']);
    expect(matchingTestUser(user!.values)).toEqual(user);
  });
});

describe('matchingTestUser', () => {
  it('finds the user whose saved values every value refers to', () => {
    const values = { USERNAME: '${SUPERVISOR_USERNAME}', PASSWORD: '${SUPERVISOR_PASSWORD}' };
    expect(matchingTestUser(values)).toEqual({ prefix: 'SUPERVISOR', label: 'Supervisor', values });
  });

  it('works for a single value', () => {
    expect(matchingTestUser({ USERNAME: '${AGENT_MARIA_USERNAME}' })).toMatchObject({ prefix: 'AGENT_MARIA', label: 'Agent Maria' });
  });

  it('is undefined without values', () => {
    expect(matchingTestUser(undefined)).toBeUndefined();
    expect(matchingTestUser({})).toBeUndefined();
  });

  it('is undefined when the values refer to two users', () => {
    expect(matchingTestUser({ USERNAME: '${SUPERVISOR_USERNAME}', PASSWORD: '${AGENT_PASSWORD}' })).toBeUndefined();
  });

  it('is undefined when any value is plain text', () => {
    expect(matchingTestUser({ USERNAME: '${SUPERVISOR_USERNAME}', COUNTRY: 'GR' })).toBeUndefined();
    expect(matchingTestUser({ USERNAME: 'maria' })).toBeUndefined();
  });

  it('is undefined when a reference is not that variable of some prefix', () => {
    expect(matchingTestUser({ USERNAME: '${AGENT_LOGIN}' })).toBeUndefined();
    expect(matchingTestUser({ USERNAME: '${USERNAME}' })).toBeUndefined();
    expect(matchingTestUser({ USERNAME: '${_USERNAME}' })).toBeUndefined();
  });

  it('returns its own copy of the values', () => {
    const values = { USERNAME: '${SUPERVISOR_USERNAME}' };
    const user = matchingTestUser(values)!;
    user.values.USERNAME = 'changed';
    expect(values.USERNAME).toBe('${SUPERVISOR_USERNAME}');
  });
});

describe('describeValues', () => {
  it('is undefined when nothing is set', () => {
    expect(describeValues(undefined)).toBeUndefined();
    expect(describeValues({})).toBeUndefined();
  });

  it('says which test user the values are', () => {
    expect(describeValues({ USERNAME: '${SUPERVISOR_USERNAME}', PASSWORD: '${SUPERVISOR_PASSWORD}' })).toBe('as Supervisor');
    expect(describeValues({ USERNAME: '${AGENT_MARIA_USERNAME}', PASSWORD: '${AGENT_MARIA_PASSWORD}' })).toBe('as Agent Maria');
  });

  it('lists each value with where it comes from otherwise', () => {
    expect(describeValues({ USERNAME: '${AGENT_USERNAME}', COUNTRY: 'GR' })).toBe('with USERNAME from AGENT_USERNAME, COUNTRY "GR"');
  });

  it('lists values of mixed users one by one', () => {
    expect(describeValues({ USERNAME: '${SUPERVISOR_USERNAME}', PASSWORD: '${AGENT_PASSWORD}' })).toBe(
      'with USERNAME from SUPERVISOR_USERNAME, PASSWORD from AGENT_PASSWORD',
    );
  });

  it('shows plain text in quotes and a reference by key only', () => {
    expect(describeValues({ POLICY_NUMBER: '12345' })).toBe('with POLICY_NUMBER "12345"');
    expect(describeValues({ PASSWORD: '${SHARED_SECRET}' })).toBe('with PASSWORD from SHARED_SECRET');
  });
});

describe('checkValues', () => {
  const settable = ['USERNAME', 'PASSWORD', 'COUNTRY', 'PIN', 'API_KEY', 'TOKEN'];
  const envKeys = ['SUPERVISOR_USERNAME', 'SUPERVISOR_PASSWORD', 'SUPERVISOR_PIN'];

  it('accepts nothing at all', () => {
    expect(checkValues({}, settable, envKeys)).toBeUndefined();
  });

  it('accepts references to saved values and plain text for settings that are not secrets', () => {
    expect(checkValues({ USERNAME: '${SUPERVISOR_USERNAME}', PASSWORD: '${SUPERVISOR_PASSWORD}' }, settable, envKeys)).toBeUndefined();
    expect(checkValues({ COUNTRY: 'GR' }, settable, envKeys)).toBeUndefined();
    expect(checkValues({ USERNAME: 'maria@example.com', COUNTRY: 'Ελλάδα' }, settable, envKeys)).toBeUndefined();
  });

  it('refuses a setting the block does not have', () => {
    expect(checkValues({ EMAIL: 'a@b.c' }, settable, envKeys)).toMatch(/no setting called EMAIL/);
    expect(checkValues({ EMAIL: '${SUPERVISOR_USERNAME}' }, settable, envKeys)).toMatch(/no setting called EMAIL/);
  });

  it('refuses a setting with no usable name before anything else', () => {
    expect(checkValues({ 'bad name': 'x' }, settable, envKeys)).toMatch(/"bad name" is not a variable name/);
    expect(checkValues({ '1ST': 'x' }, ['1ST'], envKeys)).toMatch(/not a variable name/);
    expect(checkValues({ '': 'x' }, [''], envKeys)).toMatch(/not a variable name/);
  });

  it('refuses a reference to a value that is not saved, naming both', () => {
    const problem = checkValues({ USERNAME: '${NOBODY_USERNAME}' }, settable, envKeys);
    expect(problem).toMatch(/NOBODY_USERNAME/);
    expect(problem).toMatch(/USERNAME/);
  });

  it('allows a reference to a saved value for a secret name', () => {
    expect(checkValues({ PASSWORD: '${SUPERVISOR_PASSWORD}', PIN: '${SUPERVISOR_PIN}' }, settable, envKeys)).toBeUndefined();
  });

  it('refuses typed text for a secret-looking name', () => {
    for (const variable of ['PASSWORD', 'PIN', 'API_KEY', 'TOKEN']) {
      const problem = checkValues({ [variable]: 'hunter22' }, settable, envKeys);
      expect(problem, variable).toMatch(new RegExp(`${variable} looks like a secret`));
    }
  });

  it('refuses text that mixes in a reference', () => {
    expect(checkValues({ USERNAME: 'maria-${SUPERVISOR_USERNAME}' }, settable, envKeys)).toMatch(/not a mix/);
    expect(checkValues({ USERNAME: '${SUPERVISOR_USERNAME}-x' }, settable, envKeys)).toMatch(/not a mix/);
    expect(checkValues({ USERNAME: '${' }, settable, envKeys)).toMatch(/not a mix/);
    expect(checkValues({ USERNAME: '${1}' }, settable, envKeys)).toMatch(/not a mix/);
  });

  it('refuses text over several lines', () => {
    expect(checkValues({ COUNTRY: 'a\nb' }, settable, envKeys)).toMatch(/one line/);
    expect(checkValues({ COUNTRY: 'a\r\nb' }, settable, envKeys)).toMatch(/one line/);
    expect(checkValues({ COUNTRY: 'a\rb' }, settable, envKeys)).toMatch(/one line/);
    expect(checkValues({ COUNTRY: '\n' }, settable, envKeys)).toMatch(/one line/);
  });

  it('allows up to 200 characters and refuses more', () => {
    expect(checkValues({ COUNTRY: 'x'.repeat(200) }, settable, envKeys)).toBeUndefined();
    expect(checkValues({ COUNTRY: 'x'.repeat(201) }, settable, envKeys)).toMatch(/at most 200 characters/);
  });

  it('reports the first problem in the order the values were given', () => {
    expect(checkValues({ EMAIL: 'x', PASSWORD: 'hunter22' }, settable, envKeys)).toMatch(/EMAIL/);
    expect(checkValues({ PASSWORD: 'hunter22', EMAIL: 'x' }, settable, envKeys)).toMatch(/PASSWORD/);
    expect(checkValues({ COUNTRY: 'GR', USERNAME: '${GONE}' }, settable, envKeys)).toMatch(/GONE/);
  });

  it('treats an empty list of settable variables as nothing being settable', () => {
    expect(checkValues({ USERNAME: '${SUPERVISOR_USERNAME}' }, [], envKeys)).toMatch(/no setting called USERNAME/);
  });

  it('does not take Object.prototype names for settings', () => {
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(checkValues(JSON.parse(`{"${name}": "x"}`) as Record<string, string>, settable, envKeys), name).toMatch(/no setting called/);
    }
  });
});

describe('normalizeValues', () => {
  const env = { SUPERVISOR_USERNAME: 'sup@example.com', SUPERVISOR_PASSWORD: 'hunter22', PIN_CODE: '4821', SHORT: 'abc' };

  it('is undefined when nothing is left', () => {
    expect(normalizeValues(undefined, env)).toBeUndefined();
    expect(normalizeValues({}, env)).toBeUndefined();
    expect(normalizeValues({ USERNAME: '', PASSWORD: '' }, env)).toBeUndefined();
  });

  it('drops empty values and keeps the rest', () => {
    expect(normalizeValues({ USERNAME: '', COUNTRY: 'GR' }, env)).toEqual({ COUNTRY: 'GR' });
  });

  it('turns text that is exactly a saved value into a reference to it', () => {
    expect(normalizeValues({ USERNAME: 'sup@example.com', PASSWORD: 'hunter22' }, env)).toEqual({
      USERNAME: '${SUPERVISOR_USERNAME}',
      PASSWORD: '${SUPERVISOR_PASSWORD}',
    });
  });

  it('leaves text that only contains a saved value, or differs in case or spacing', () => {
    expect(normalizeValues({ USERNAME: 'x sup@example.com' }, env)).toEqual({ USERNAME: 'x sup@example.com' });
    expect(normalizeValues({ USERNAME: 'SUP@example.com' }, env)).toEqual({ USERNAME: 'SUP@example.com' });
    expect(normalizeValues({ PASSWORD: ' hunter22' }, env)).toEqual({ PASSWORD: ' hunter22' });
    expect(normalizeValues({ PASSWORD: 'hunter22 ' }, env)).toEqual({ PASSWORD: 'hunter22 ' });
  });

  it('only converts saved values of four or more characters', () => {
    expect(normalizeValues({ PIN: '4821' }, env)).toEqual({ PIN: '${PIN_CODE}' });
    expect(normalizeValues({ COUNTRY: 'abc' }, env)).toEqual({ COUNTRY: 'abc' });
    expect(normalizeValues({ COUNTRY: 'abc' }, { A: 'abc', B: '' })).toEqual({ COUNTRY: 'abc' });
    expect(normalizeValues({ COUNTRY: 'x' }, { A: '' })).toEqual({ COUNTRY: 'x' });
  });

  it('leaves a reference as it is, even to a value that is not saved', () => {
    expect(normalizeValues({ USERNAME: '${GONE}' }, env)).toEqual({ USERNAME: '${GONE}' });
    expect(normalizeValues({ USERNAME: '${SUPERVISOR_USERNAME}' }, env)).toEqual({ USERNAME: '${SUPERVISOR_USERNAME}' });
  });

  it('refers to one of the keys when two saved values are the same', () => {
    expect(normalizeValues({ PASSWORD: 'same-value' }, { A_PASSWORD: 'same-value', B_PASSWORD: 'same-value' })?.PASSWORD).toMatch(/^\$\{(A|B)_PASSWORD\}$/);
  });

  it('works without any saved values', () => {
    expect(normalizeValues({ COUNTRY: 'GR', USERNAME: '' }, {})).toEqual({ COUNTRY: 'GR' });
  });

  it('does not change its input', () => {
    const input = Object.freeze({ USERNAME: 'sup@example.com', COUNTRY: '' });
    normalizeValues(input, env);
    expect(input).toEqual({ USERNAME: 'sup@example.com', COUNTRY: '' });
  });

  it('gives values that pass checkValues for a secret setting once a pasted secret is a reference', () => {
    const normalized = normalizeValues({ PASSWORD: 'hunter22' }, env)!;
    expect(checkValues(normalized, ['PASSWORD'], Object.keys(env))).toBeUndefined();
    // The same text that is not a saved value stays typed text, which a secret name refuses.
    expect(checkValues(normalizeValues({ PASSWORD: 'other-secret' }, env)!, ['PASSWORD'], Object.keys(env))).toMatch(/looks like a secret/);
  });
});

describe('resolveValues', () => {
  const env = { SUPERVISOR_USERNAME: 'sup@example.com', SUPERVISOR_PASSWORD: 'hunter22' };

  it('replaces references with the saved values and keeps plain text', () => {
    expect(resolveValues({ USERNAME: '${SUPERVISOR_USERNAME}', PASSWORD: '${SUPERVISOR_PASSWORD}', COUNTRY: 'GR' }, env)).toEqual({
      USERNAME: 'sup@example.com',
      PASSWORD: 'hunter22',
      COUNTRY: 'GR',
    });
  });

  it('is empty without values', () => {
    expect(resolveValues(undefined, env)).toEqual({});
    expect(resolveValues({}, env)).toEqual({});
  });

  it('resolves a reference to a missing value to an empty string', () => {
    expect(resolveValues({ USERNAME: '${GONE}' }, env)).toEqual({ USERNAME: '' });
  });

  it('leaves text that merely looks like a reference alone', () => {
    expect(resolveValues({ USERNAME: 'x${SUPERVISOR_USERNAME}' }, env)).toEqual({ USERNAME: 'x${SUPERVISOR_USERNAME}' });
  });
});

describe('passwordSetting', () => {
  it('is PASSWORD when no saved value looks like a password', () => {
    expect(passwordSetting([])).toBe('PASSWORD');
    expect(passwordSetting(['EMAIL', 'API_TOKEN'])).toBe('PASSWORD');
  });

  it('is the saved value with PASS in its name, in any case', () => {
    expect(passwordSetting(['EMAIL', 'ADMIN_PASSCODE'])).toBe('ADMIN_PASSCODE');
    expect(passwordSetting(['admin_Passcode'])).toBe('admin_Passcode');
  });

  it('is the first in sort order when several fit and none is PASSWORD', () => {
    expect(passwordSetting(['USER_PASSWORD', 'ADMIN_PASSWORD', 'SUPERVISOR_PASSWORD'])).toBe('ADMIN_PASSWORD');
  });

  it('is PASSWORD itself when it is saved, even beside others that sort first', () => {
    expect(passwordSetting(['USER_PASSWORD', 'ADMIN_PASSWORD', 'PASSWORD'])).toBe('PASSWORD');
    expect(passwordSetting(['PASSWORD', 'SUPERVISOR_PASSWORD'])).toBe('PASSWORD');
  });

  it.each(['PASSPORT_NUMBER', 'BYPASS_CODE', 'COMPASS_HEADING', 'ADMIN_PASSPORT'])('does not take %s for a password', (key) => {
    expect(passwordSetting([key])).toBe('PASSWORD');
  });

  it('skips a name that only contains pass for the password beside it', () => {
    expect(passwordSetting(['ADMIN_PASSPORT', 'USER_PASSWORD'])).toBe('USER_PASSWORD');
  });

  it.each(['USER_PASS', 'PASS', 'ADMIN_PASSWD', 'ADMIN_PASSCODE', 'WIFI_PASSPHRASE', 'MYPASSWORD'])('takes %s for a password', (key) => {
    expect(passwordSetting([key])).toBe(key);
  });

  it('does not change the list it is given', () => {
    const keys = ['USER_PASSWORD', 'ADMIN_PASSWORD'];
    passwordSetting(keys);
    expect(keys).toEqual(['USER_PASSWORD', 'ADMIN_PASSWORD']);
  });
});
