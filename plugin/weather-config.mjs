// Reads and checks the weather fields of a world (world.json, region files) and builds the config weather.mjs runs on.
// Creator-facing temperatures (indoor_temp, temp_offset, fixed_weather.temp, custom climates) are in the world's
// temperature_unit ("F" by default); everything handed to the engine is °C.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INSULATION, fToC } from './ui/weather.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8'));
export const SKY_TYPES = readJson(path.join(HERE, 'sky_types.json'));
export const WIND_LEVELS = readJson(path.join(HERE, 'wind_levels.json'));
export const CLIMATES = Object.fromEntries(fs.readdirSync(path.join(HERE, 'climates')).filter(f => f.endsWith('.json')).sort()
    .map(f => [path.basename(f, '.json'), readJson(path.join(HERE, 'climates', f))]));
export const CLIMATE_ALIASES = { temperate: 'humid_continental_warm_summer' };
export const DEFAULT_CLIMATE = 'temperate';
export const EXPOSURES = ['outdoor', 'sheltered', 'enclosed', 'fixed'];
export const PLACE_FIELDS = ['exposure', 'indoor_temp', 'insulation', 'fixed_weather', 'temp_offset'];
export const REGION_WEATHER_FIELDS = ['weather_region', 'climate', 'seasons', 'daylight_adjust'];

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => isObj(o) && Object.prototype.hasOwnProperty.call(o, k);
const num = v => typeof v === 'number' && Number.isFinite(v);
const J = JSON.stringify;

/** Check a place's own exposure fields (region, subregion or location); returns them in °C, missing ones left out. */
export function checkPlace(o, where, unit = 'F', fail = m => { throw new Error(m); }) {
    const out = {}, deg = v => (unit === 'C' ? v : fToC(v)), diff = v => (unit === 'C' ? v : v * 5 / 9);
    if (has(o, 'exposure')) { if (!EXPOSURES.includes(o.exposure)) fail(`${where}: "exposure" must be one of ${EXPOSURES.join(', ')}`); out.exposure = o.exposure; }
    if (has(o, 'indoor_temp') && o.indoor_temp === null) out.indoor_temp = null; // explicitly unheated (stops the cascade)
    else if (has(o, 'indoor_temp')) { if (!num(o.indoor_temp)) fail(`${where}: "indoor_temp" must be a number (°${unit})`); out.indoor_temp = deg(o.indoor_temp); }
    if (has(o, 'insulation')) { if (!has(INSULATION, o.insulation)) fail(`${where}: "insulation" must be one of ${Object.keys(INSULATION).join(', ')}`); out.insulation = o.insulation; }
    if (has(o, 'temp_offset')) { if (!num(o.temp_offset)) fail(`${where}: "temp_offset" must be a number (°${unit})`); out.temp_offset = diff(o.temp_offset); }
    if (has(o, 'fixed_weather')) {
        const f = o.fixed_weather;
        if (!isObj(f) || typeof f.condition !== 'string' || !f.condition.trim()) fail(`${where}: "fixed_weather" must look like {"condition": "Eternal twilight, still air", "temp": 60}`);
        if (has(f, 'temp') && !num(f.temp)) fail(`${where}: "fixed_weather.temp" must be a number (°${unit})`);
        out.fixed_weather = { condition: f.condition.trim(), temp: has(f, 'temp') ? deg(f.temp) : null };
    }
    return out;
}

function checkClimate(cl, where, unit) {
    if (!isObj(cl)) throw new Error(`${where}: must be a climate name or an object`);
    const d = cl.daylight;
    if (!isObj(d) || !num(d.summer) || !num(d.winter)) throw new Error(`${where}: needs "daylight": {"summer": hours, "winter": hours}`);
    if (!isObj(cl.seasons) || !Object.keys(cl.seasons).length) throw new Error(`${where}: "seasons" must be an object keyed by season name`);
    const deg = v => (unit === 'C' ? v : fToC(v)), seasons = {};
    for (const [name, s] of Object.entries(cl.seasons)) {
        const w = `${where}: season ${J(name)}`;
        if (!isObj(s)) throw new Error(`${w}: must be an object`);
        for (const k of ['high', 'low', 'humidity']) if (!num(s[k])) throw new Error(`${w}: "${k}" must be a number`);
        if (!isObj(s.sky) || !Object.entries(s.sky).every(([k, v]) => has(SKY_TYPES, k) && num(v) && v >= 0) || !Object.values(s.sky).some(v => v > 0))
            throw new Error(`${w}: "sky" must give odds for sky types (${Object.keys(SKY_TYPES).join(', ')})`);
        if (has(s, 'windiness') && !(num(s.windiness) && s.windiness > 0)) throw new Error(`${w}: "windiness" must be a number above 0`);
        if (has(s, 'months') && !(Array.isArray(s.months) && s.months.every(m => typeof m === 'string'))) throw new Error(`${w}: "months" must be a list of month names`);
        seasons[name] = { high: deg(s.high), low: deg(s.low), humidity: s.humidity, sky: { ...s.sky }, windiness: s.windiness ?? 1, months: s.months ?? [] };
    }
    return { name: cl.name ?? '', koppen: cl.koppen ?? '', daylight: { summer: d.summer, winter: d.winter }, seasons };
}

/** Find a climate by name: the world's own climates, then presets by id, Köppen code or alias. */
function findClimate(name, worldClimates, where, unit) {
    if (typeof name !== 'string') return checkClimate(name, where, unit);
    if (has(worldClimates, name)) return checkClimate(worldClimates[name], `world.json: climates.${name}`, unit);
    const key = CLIMATE_ALIASES[name] ?? name;
    const preset = CLIMATES[key] ?? Object.values(CLIMATES).find(c => c.koppen.toLowerCase() === key.toLowerCase());
    if (!preset) throw new Error(`${where}: unknown climate ${J(name)} (presets: ${Object.keys(CLIMATES).join(', ')}, or a Köppen code like "Cfb")`);
    return checkClimate(preset, `climate ${name}`, 'C');
}

/** Season name for every calendar month: explicit {season: [months]} or the climate's own months, else an even split. */
function monthSeasons(climate, override, cal, where) {
    const names = Object.keys(climate.seasons), idx = m => cal.months.findIndex(x => x.name.toLowerCase() === String(m).toLowerCase());
    const out = new Array(cal.months.length).fill(null);
    let src = override;
    if (src !== undefined) {
        if (!isObj(src)) throw new Error(`${where}: "seasons" must look like {"winter": ["December", "January", "February"], ...}`);
    } else {
        src = Object.fromEntries(names.map(n => [n, climate.seasons[n].months]));
        if (!Object.values(src).flat().every(m => idx(m) >= 0) || Object.values(src).flat().length !== cal.months.length) {
            const per = cal.months.length / names.length; // custom calendar: split months evenly in season order
            return cal.months.map((_, i) => names[Math.min(names.length - 1, Math.floor(i / per))]);
        }
    }
    for (const [n, months] of Object.entries(src)) {
        if (!names.includes(n)) throw new Error(`${where}: season ${J(n)} is not in the climate (it has ${names.join(', ')})`);
        if (!Array.isArray(months)) throw new Error(`${where}: season ${J(n)} must be a list of month names`);
        for (const m of months) {
            const i = idx(m);
            if (i < 0) throw new Error(`${where}: there is no month ${J(m)} in the calendar`);
            if (out[i]) throw new Error(`${where}: month ${J(m)} is in two seasons`);
            out[i] = n;
        }
    }
    const missing = cal.months.filter((_, i) => !out[i]).map(m => m.name);
    if (missing.length) throw new Error(`${where}: these months have no season: ${missing.join(', ')}`);
    const runs = out.filter((n, i) => n !== out[(i - 1 + out.length) % out.length]).length || 1;
    if (runs !== new Set(out).size) throw new Error(`${where}: each season's months must be in a row`);
    return out;
}

/**
 * The whole world's weather setup. Returns {config (for weather.mjs), regionOf: {region id -> weather region id}, places: {region id -> own place fields}}.
 * Throws Error with a readable message.
 */
export function buildWeather(worldJson, rawRegions, cal, worldId = '') {
    const unit = worldJson.temperature_unit ?? 'F';
    if (!['F', 'C'].includes(unit)) throw new Error('world.json: "temperature_unit" must be "F" or "C"');
    if (has(worldJson, 'weather_seed') && typeof worldJson.weather_seed !== 'string' && !num(worldJson.weather_seed)) throw new Error('world.json: "weather_seed" must be a string or number');
    const wc = worldJson.climates ?? {};
    if (!isObj(wc)) throw new Error('world.json: "climates" must be an object keyed by climate name');
    const wrs = worldJson.weather_regions ?? {};
    if (!isObj(wrs)) throw new Error('world.json: "weather_regions" must be an object keyed by weather region id');
    const regions = {}, regionOf = {}, used = new Set();
    const make = (src, fallback, where) => {
        if (has(src, 'daylight_adjust') && !num(src.daylight_adjust)) throw new Error(`${where}: "daylight_adjust" must be a number of hours`);
        const pickF = k => (has(src, k) ? src[k] : fallback?.[k]);
        const climate = findClimate(pickF('climate') ?? DEFAULT_CLIMATE, wc, `${where}: climate`, unit);
        return { climate, months: monthSeasons(climate, pickF('seasons'), cal, where), daylight_adjust: pickF('daylight_adjust') ?? 0 };
    };
    for (const [rid, data] of Object.entries(rawRegions)) {
        const fname = `${rid}.json`;
        if (has(data, 'weather_region')) {
            const id = data.weather_region;
            if (typeof id !== 'string' || !has(wrs, id)) throw new Error(`${fname}: "weather_region" ${J(id)} is not defined in world.json "weather_regions"`);
            if (!isObj(wrs[id])) throw new Error(`world.json: weather_regions.${id} must be an object`);
            // The weather region's own settings win over the region's.
            if (!regions[id]) regions[id] = make(wrs[id], data, `world.json: weather_regions.${id}`);
            regionOf[rid] = id; used.add(id);
        } else {
            const id = `@${rid}`;
            regions[id] = make(data, null, fname);
            regionOf[rid] = id;
        }
    }
    const seed = String(worldJson.weather_seed ?? (worldJson.name || worldId || 'world'));
    return { config: { seed, unit, skies: SKY_TYPES, winds: WIND_LEVELS, regions }, regionOf, unit };
}
