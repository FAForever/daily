// Transform the raw FAF unit DB export (scripts/source-unitlist.json) into the
// trimmed, derived unit list the game uses (src/data/units.json).
//
//   node scripts/build-units.mjs
//
// Re-run this after dropping a newer unitlist.json export into scripts/.
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(readFileSync(join(here, 'source-unitlist.json'), 'utf8'));
const units = raw.units;

const has = (u, tag) => (u.Categories || []).includes(tag);
const abil = (u) => (u.Display && u.Display.Abilities) || [];

function techOf(u) {
  if (has(u, 'CRABEGG')) return ['—', 0];
  if (has(u, 'COMMAND')) return ['—', 0]; // ACU — no tier
  if (has(u, 'SUBCOMMANDER')) return ['T3', 3]; // sACU
  if (has(u, 'EXPERIMENTAL')) return ['EXP', 4];
  if (has(u, 'TECH3')) return ['T3', 3];
  if (has(u, 'TECH2')) return ['T2', 2];
  if (has(u, 'TECH1')) return ['T1', 1];
  return [null, 0];
}

// Movement layer, by precedence: Air > Naval > Hover > Amphibious > Land.
function domainOf(u) {
  const i = (u.General && u.General.Icon) || '';
  if (i === 'air') return 'Air';
  if (i === 'sea') return 'Naval';
  const a = abil(u);
  if (a.includes('Hover')) return 'Hover';
  if (i === 'amph' || a.includes('Amphibious') || a.includes('Aquatic')) return 'Amphibious';
  return 'Land';
}

function weaponOf(u) {
  const set = new Set();
  (u.Weapon || []).forEach((w) => {
    const c = w.WeaponCategory || '';
    if (/Anti Air/i.test(c)) set.add('Anti-Air');
    else if (/Anti Navy/i.test(c)) set.add('Torpedoes'); // anti-naval = torpedoes
    else if (/Artillery|Missile|Indirect|Bomb/i.test(c)) set.add('Indirect');
    else if (/Direct Fire/i.test(c)) set.add('Direct Fire');
  });
  return set.size ? [...set] : ['None'];
}

// Energy users whose cost isn't passive maintenance and isn't an artillery
// weapon, so the data export shows 0 — flagged as Upkeep explicitly.
//   air staging (refuels aircraft on energy) + a few named units.
// (Artillery that fires on energy, incl. experimentals like Mavor/Scathis/
// Salvation, is caught by its weapon's energy cost in producesOf — not listed here.)
const ENERGY_UPKEEP_EXTRA = new Set([
  'UAB5202', // Air Staging — Cradle
  'UEB5202', // Air Staging — Refuel & Repair
  'URB5202', // Air Staging Facility
  'XSB5202', // Air Staging — Iathu-uhthe
  'XEB2306', // Ravager
  'XAB3301', // Eye of Rhianne
  'XSA0302', // Iaselen (mobile omni)
  'XEA0002', // Novax Defense Satellite — fires on energy (v3837)
]);

// Resources a unit makes or needs. The three are independent tags — a unit
// shows every one that applies (e.g. a T1 mex is Mass + Buildpower + Upkeep).
//   - Mass / Energy: production (same category tags as before).
//   - Buildpower: any build rate.
//   - Upkeep: drains energy. Passive maintenance comes from the data; a few
//     firing/activity users show 0 there and are listed in ENERGY_UPKEEP_EXTRA.
//     Artillery that needs energy per shot (static and experimental artillery;
//     the weapon carries EnergyRequired) counts too. Mobile artillery has no
//     energy cost, so it is not flagged. A builder's own build drain already
//     covers its mass+energy, so artillery only adds Upkeep for non-builders
//     (keeps the Megalith on Buildpower, not Upkeep).
function producesOf(u) {
  const e = u.Economy || {};
  const builds = (e.BuildRate || 0) > 0;
  const r = [];
  if (has(u, 'MASSPRODUCTION')) r.push('Mass');
  if (has(u, 'ENERGYPRODUCTION')) r.push('Energy');
  if (builds) r.push('Buildpower');
  const firesOnEnergy = (u.Weapon || []).some(
    (w) =>
      /^Artillery$/i.test(w.WeaponCategory || '') &&
      ((w.EnergyRequired || 0) > 0 || (w.EnergyDrainPerSecond || 0) > 0),
  );
  const upkeep =
    (e.MaintenanceConsumptionPerSecondEnergy || 0) > 0 ||
    ENERGY_UPKEEP_EXTRA.has(u.Id) ||
    (firesOnEnergy && !builds);
  if (upkeep) r.push('E upkeep');
  return r.length ? r : ['None'];
}

function typeOf(u) {
  if (has(u, 'CRABEGG')) return 'Egg';
  return has(u, 'STRUCTURE') ? 'Building' : 'Unit';
}

// Roles are multi-value: a unit can be e.g. Combat + Intel.
function rolesOf(u, weapons) {
  if (has(u, 'CRABEGG')) return ['Egg'];
  const r = new Set();
  const canShoot = weapons.some((w) => w !== 'None');
  const a = abil(u);
  const isFactory = has(u, 'FACTORY') || has(u, 'EXTERNALFACTORY') || a.includes('Factory');
  const isCarrier = has(u, 'CARRIER') || a.includes('Carrier');
  const isTransport = has(u, 'TRANSPORTATION') || a.includes('Transport');
  if (has(u, 'MOBILE') && canShoot) r.add('Combat');
  if (isCarrier) r.add('Combat'); // carriers (incl. Atlantis) count as combat
  if (isFactory) r.add('Factory');
  if (isTransport) r.add('Transport');
  // True engineers + commanders only — NOT factories (which also have CONSTRUCTION).
  if (has(u, 'ENGINEER') || has(u, 'COMMAND') || has(u, 'SUBCOMMANDER')) r.add('Engineer');
  if (has(u, 'STRUCTURE') && has(u, 'DEFENSE')) r.add('Defense');
  if (has(u, 'ECONOMIC')) r.add('Economy');
  if (has(u, 'INTELLIGENCE')) r.add('Intel');
  if (has(u, 'SHIELD')) r.add('Shield');
  if (r.size === 0) r.add('Support');
  return [...r];
}

// Special capabilities (movement lives in Domain; weapons in Weapon).
const ABILITY_WHITELIST = new Set([
  'Shield Dome', 'Personal Shield', 'Stealth Field', 'Personal Stealth', 'Cloaking',
  'Submersible', 'Transport', 'Carrier', 'Sonar', 'Radar', 'Omni Sensor', 'Jamming',
  'Tactical Missile Defense', 'Strategic Missile Defense', 'Torpedo Defense',
  'EMP Weapon', 'Suicide Weapon', 'Sacrifice', 'Massive', 'Volatile', 'Air Staging',
]);

function abilitiesOf(u) {
  if (has(u, 'CRABEGG')) return ['Egg'];
  const a = abil(u);
  const set = new Set(a.filter((x) => ABILITY_WHITELIST.has(x)));
  // derived: reclaim + assist (build/repair) — added wherever the unit can do it
  if (has(u, 'RECLAIM') || has(u, 'COMMAND') || has(u, 'SUBCOMMANDER')) set.add('Reclaim');
  // Assist = can help-build/repair. Engineers, commanders, and units with an
  // engineering/repair ability (e.g. Mantis). NOT factories.
  if (
    has(u, 'ENGINEER') || has(u, 'COMMAND') || has(u, 'SUBCOMMANDER') ||
    a.includes('Engineering Suite') || a.includes('Repairs')
  ) {
    set.add('Assist');
  }
  if (has(u, 'CAPTURE') || a.includes('Reclaims') || a.includes('Capture')) set.add('Capture');
  return set.size ? [...set] : ['None'];
}

const pool = units
  .filter(
    (u) =>
      u.General &&
      u.General.FactionName &&
      u.General.FactionName !== 'Nomads' &&
      (u.General.UnitName || u.Description) &&
      (has(u, 'SELECTABLE') || has(u, 'CRABEGG')) &&
      (has(u, 'MOBILE') || has(u, 'STRUCTURE') || has(u, 'CRABEGG')) &&
      (techOf(u)[0] || has(u, 'CRABEGG'))
  )
  .map((u) => {
    const [tech, techRank] = techOf(u);
    const weapon = weaponOf(u);
    return {
      id: u.Id,
      name: u.General.UnitName || u.Description,
      desc: u.Description || '',
      faction: u.General.FactionName,
      tech,
      techRank,
      type: typeOf(u),
      domain: domainOf(u),
      weapon,
      produces: producesOf(u),
      role: rolesOf(u, weapon),
      mass: u.Economy?.BuildCostMass ?? 0,
      energy: u.Economy?.BuildCostEnergy ?? 0,
      hp: u.Defense?.Health ?? 0,
      buildTime: u.Economy?.BuildTime ?? 0,
      abilities: abilitiesOf(u),
    };
  })
  // Costliest-first so the stable alphabetical sort below keeps costlier variants
  // first within a shared-name group (e.g. The Hive ×3). This fixes the array
  // indices that dailyIndex() resolves to — reordering would shift every daily answer.
  .sort((a, b) => b.mass - a.mass);

// Dedup only true cell-duplicates — units with identical 11-cell signatures are indistinguishable in the guess grid.
const byCells = new Map();
for (const u of pool) {
  const sig = JSON.stringify([
    u.faction, u.tech, u.type, u.domain,
    [...u.weapon].sort(), [...u.produces].sort(), [...u.role].sort(),
    u.mass, u.hp, u.buildTime, [...u.abilities].sort(),
  ]);
  if (!byCells.has(sig)) byCells.set(sig, u);
}
const out = [...byCells.values()].sort((a, b) => a.name.localeCompare(b.name));

const removed = pool.length - out.length;
if (removed > 0) {
  console.warn(`Warning: ${removed} unit${removed === 1 ? ' was' : 's were'} removed by de-duplication (${pool.length} → ${out.length})`);
}

writeFileSync(join(here, '..', 'src', 'data', 'units.json'), JSON.stringify(out, null, 0) + '\n');

console.log(`Wrote ${out.length} units to src/data/units.json`);
const fac = {};
out.forEach((u) => (fac[u.faction] = (fac[u.faction] || 0) + 1));
console.log('by faction:', fac);
