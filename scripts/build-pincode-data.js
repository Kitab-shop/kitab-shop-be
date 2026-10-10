/**
 * Builds src/data/pincodes.json — the lookup table behind
 * GET /api/v1/geo/pincode/:pincode — from India Post's "All India Pincode
 * Directory" CSV (Department of Posts, published on data.gov.in under the
 * Government Open Data License).
 *
 * Expected columns (the official OGD export):
 *   CircleName, RegionName, DivisionName, OfficeName, Pincode, OfficeType,
 *   Delivery, District, StateName, Latitude, Longitude
 *
 * One PIN can span several post offices — and, near borders, several
 * districts or even states. The district/state kept for a PIN is whichever
 * the majority of its offices report; every office name becomes a locality
 * suggestion for "Address Line 2".
 *
 * Output is deliberately compact (states and districts are interned into
 * arrays and referenced by index) so the backend can hold the whole table in
 * memory:
 *   { version, source, states: [...], districts: [...],
 *     pins: { "110001": [districtIndex, stateIndex, ["Connaught Place", ...]] } }
 *
 * Fails (exit 1) on any state name it cannot map to INDIAN_STATES, so a new
 * or renamed state/UT can never ship as an unselectable value.
 *
 *   npm run build:pincodes -- /path/to/pincode.csv
 */
import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { INDIAN_PINCODE_REGEX, INDIAN_STATES } from "../src/config/india-geo.config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = resolve(__dirname, "../src/data/pincodes.json");

const csvPath = process.argv[2];
if (!csvPath) {
  console.error("Usage: npm run build:pincodes -- /path/to/pincode.csv");
  process.exit(1);
}

// Minimal RFC 4180 line parser — the directory quotes every field and office
// names occasionally contain commas, so a plain split(",") is not enough.
const parseCsvLine = (line) => {
  const fields = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      fields.push(field);
      field = "";
    } else {
      field += char;
    }
  }
  fields.push(field);
  return fields;
};

const SMALL_WORDS = new Set(["and", "of", "the"]);

const titleCase = (value) =>
  value
    .toLowerCase()
    .replace(/(^|[\s\-.(/])([a-z])/g, (_, boundary, letter) => boundary + letter.toUpperCase())
    .replace(/\s(And|Of|The)\b/g, (match, word) =>
      SMALL_WORDS.has(word.toLowerCase()) ? ` ${word.toLowerCase()}` : match,
    )
    .replace(/\s+/g, " ")
    .trim();

// The directory is a mix of "ANANTAPUR" and "Budgam"; normalise only the
// shouted ones so mixed-case names keep their intended capitalisation.
const tidyName = (value) => {
  const trimmed = value.trim();
  return trimmed === trimmed.toUpperCase() ? titleCase(trimmed) : trimmed.replace(/\s+/g, " ");
};

// "Connaught Place SO" → "Connaught Place". The suffix is the office's type
// in the postal hierarchy, which means nothing to a customer typing an area.
const OFFICE_SUFFIX = /[\s.]+(?:B\.?\s?O|S\.?\s?O|H\.?\s?O|G\.?\s?P\.?\s?O|P\.?\s?O|M\.?\s?D\.?\s?G)\.?$/i;
// Counters inside a building (court, ministry) are not a locality.
const NOT_A_LOCALITY = /\b(?:EXTN|EXTENSION)\b.*\bCOUNTER\b|\bCOUNTER$/i;

const toLocality = (officeName) => {
  if (NOT_A_LOCALITY.test(officeName)) return null;
  const name = tidyName(officeName.replace(OFFICE_SUFFIX, ""));
  return name.length >= 2 ? name : null;
};

const STATE_BY_KEY = new Map(INDIAN_STATES.map((state) => [state.toLowerCase(), state]));
const canonicalState = (rawState) =>
  STATE_BY_KEY.get(rawState.trim().toLowerCase().replace(/^the\s+/, "").replace(/\s+/g, " ")) || null;

const mostCommon = (counts) => [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];

const byPin = new Map();
const unmappedStates = new Map();
let header = null;
let rowCount = 0;

const lines = createInterface({ input: createReadStream(csvPath, "utf8"), crlfDelay: Infinity });
for await (const rawLine of lines) {
  const line = rawLine.replace(/^﻿/, "");
  if (!line.trim()) continue;
  const fields = parseCsvLine(line);

  if (!header) {
    header = Object.fromEntries(fields.map((name, index) => [name.trim().toLowerCase(), index]));
    for (const column of ["officename", "pincode", "delivery", "district", "statename"]) {
      if (!(column in header)) {
        console.error(`Missing column "${column}" — is this the India Post directory CSV?`);
        process.exit(1);
      }
    }
    continue;
  }

  rowCount += 1;
  const pincode = fields[header.pincode]?.trim();
  if (!INDIAN_PINCODE_REGEX.test(pincode || "")) continue;
  // The export ships at least one placeholder row ("TEST OFFICE", 999999).
  if (/^\s*(?:test|dummy)\b/i.test(fields[header.officename] || "")) continue;

  const rawState = fields[header.statename] || "";
  const state = canonicalState(rawState);
  if (!state) {
    unmappedStates.set(rawState, (unmappedStates.get(rawState) || 0) + 1);
    continue;
  }

  const district = tidyName(fields[header.district] || "");
  const entry = byPin.get(pincode) || {
    districts: new Map(),
    states: new Map(),
    delivery: [],
    nonDelivery: [],
  };
  if (district) entry.districts.set(district, (entry.districts.get(district) || 0) + 1);
  entry.states.set(state, (entry.states.get(state) || 0) + 1);

  const locality = toLocality(fields[header.officename] || "");
  if (locality) {
    const isDelivery = /^delivery$/i.test((fields[header.delivery] || "").trim());
    (isDelivery ? entry.delivery : entry.nonDelivery).push(locality);
  }
  byPin.set(pincode, entry);
}

if (unmappedStates.size > 0) {
  console.error("These state names do not match INDIAN_STATES — map them in canonicalState():");
  for (const [name, count] of unmappedStates) console.error(`  "${name}" (${count} rows)`);
  process.exit(1);
}

const states = [];
const districts = [];
const stateIndex = new Map();
const districtIndex = new Map();
const intern = (value, list, index) => {
  if (!index.has(value)) {
    index.set(value, list.length);
    list.push(value);
  }
  return index.get(value);
};

const pins = {};
for (const pincode of [...byPin.keys()].sort()) {
  const entry = byPin.get(pincode);
  if (entry.districts.size === 0) continue;

  // Delivery offices first — those are where parcels actually land.
  const seen = new Set();
  const localities = [...entry.delivery, ...entry.nonDelivery].filter((name) => {
    const key = name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  pins[pincode] = [
    intern(mostCommon(entry.districts), districts, districtIndex),
    intern(mostCommon(entry.states), states, stateIndex),
    localities,
  ];
}

const output = {
  version: new Date().toISOString().slice(0, 10),
  source: "India Post — All India Pincode Directory (data.gov.in, GODL-India)",
  states,
  districts,
  pins,
};

await mkdir(dirname(OUTPUT_PATH), { recursive: true });
const json = JSON.stringify(output);
await writeFile(OUTPUT_PATH, `${json}\n`);

console.log(
  `Read ${rowCount} offices → ${Object.keys(pins).length} pincodes, ` +
    `${districts.length} districts, ${states.length} states/UTs ` +
    `(${(json.length / 1024 / 1024).toFixed(2)} MB) → ${OUTPUT_PATH}`,
);
