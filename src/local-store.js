import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const directory = path.resolve(process.env.FORM_DATA_DIR || '.local');
const file = path.join(directory, 'form-fitness.json');
const plans = [
  { id: 'basic', name: 'Essential', price_cents: 89900, days: 30, available: true, description: 'A solid foundation for your fitness routine.', features: ['Unlimited gym access', 'All strength equipment', 'Locker room access', 'Fitness orientation'] },
  { id: 'plus', name: 'Momentum', price_cents: 149900, days: 30, available: true, description: 'More variety. More support. More momentum.', features: ['Everything in Essential', 'Unlimited group classes', 'Monthly fitness check-in', 'One guest pass per cycle'] },
  { id: 'elite', name: 'Performance', price_cents: 249900, days: 30, available: true, description: 'Focused coaching for your personal best.', features: ['Everything in Momentum', '4 personal training sessions', 'Personalized workout plan', 'Priority class booking'] }
];

function emptyStore() {
  return {
    version: 1,
    qrSecret: randomBytes(32).toString('hex'),
    accounts: [],
    sessions: [],
    profiles: [],
    memberships: [],
    invoices: [],
    payments: [],
    submissions: [],
    checkins: [],
    plans: structuredClone(plans),
    settings: { payments: {} },
    notifications: []
  };
}

export function loadStore() {
  mkdirSync(directory, { recursive: true });
  try {
    const store = JSON.parse(readFileSync(file, 'utf8'));
    const defaults = emptyStore();
    for (const [key, value] of Object.entries(defaults)) if (!(key in store)) store[key] = value;
    if (!store.settings || typeof store.settings !== 'object') store.settings = { payments: {} };
    return store;
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Local data file is invalid: ${file}`);
    const store = emptyStore();
    saveStore(store);
    return store;
  }
}

export function saveStore(store) {
  mkdirSync(directory, { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(store, null, 2), { mode: 0o600 });
  renameSync(temporary, file);
}

export const newId = () => randomUUID();
export const token = () => randomBytes(32).toString('hex');
export const digest = value => createHash('sha256').update(value).digest('hex');
export function passwordHash(value, salt = randomBytes(16).toString('hex')) {
  return { salt, hash: scryptSync(value, salt, 64).toString('hex') };
}
export function passwordMatches(value, account) {
  if (!account || typeof value !== 'string') return false;
  const candidate = scryptSync(value, account.salt, 64);
  const expected = Buffer.from(account.hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}
