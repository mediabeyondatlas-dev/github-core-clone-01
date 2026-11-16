// The token's identity, derived the same way the suite derives its scenario:
// one fixed seed (SCENARIO_SEED) feeds a named xorshift64* stream, and the
// first user that stream builds is the viewer. Ported from the kit's wire.ts
// so this server answers GET /api/v3/user and GraphQL viewer{login} with the
// exact login the suite expects, without any clock or unseeded randomness.

const SCENARIO_SEED = 0x6a09e667f3bcc909n;
const U64_MASK = 0xffffffffffffffffn;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

function scenarioSeedFor(label: string): bigint {
  return mix64(SCENARIO_SEED ^ fnv1a64(label));
}

class Rng {
  #state: bigint;

  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }

  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }

  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }

  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }

  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)] as T;
  }
}

const FIRST_NAMES: readonly string[] = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];

const LAST_NAMES: readonly string[] = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

export interface Viewer {
  readonly id: number;
  readonly login: string;
  readonly name: string;
  readonly email: string;
}

function generateUsers(rng: Rng, count: number): Viewer[] {
  const used = new Set<string>();
  const users: Viewer[] = [];
  for (let i = 0; i < count; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}

/** The login the bearer token names. */
export const VIEWER: Viewer = generateUsers(new Rng(scenarioSeedFor('users')), 12)[0] as Viewer;

/** The trial's opening time, as an ISO string and as epoch seconds. Never the wall clock. */
export const TRIAL_NOW_ISO: string = (() => {
  const raw = (process.env.MAKEFUN_TRIAL_NOW ?? '').trim();
  if (raw !== '') {
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  return '2025-01-01T00:00:00.000Z';
})();

export const TRIAL_NOW_SEC: number = Math.floor(Date.parse(TRIAL_NOW_ISO) / 1000);

/** The trial seed, for any random choice the forge must make (none today). */
export const TRIAL_SEED: string = (process.env.MAKEFUN_TRIAL_SEED ?? '').trim();

/** The bearer token this trial's requests carry. */
export const SHOP_TOKEN: string = process.env.MAKEFUN_SHOP_TOKEN ?? '';
