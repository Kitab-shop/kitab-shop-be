import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { INDIAN_PINCODE_REGEX } from "../../config/india-geo.config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = resolve(__dirname, "../../data/pincodes.json");

// ~2 MB of JSON, parsed on the first lookup rather than at boot so servers
// that never render a checkout don't pay for it. Built by
// scripts/build-pincode-data.js from India Post's pincode directory.
let table = null;

const loadTable = () => {
  if (!table) table = JSON.parse(readFileSync(DATA_PATH, "utf8"));
  return table;
};

// India Post has no notion of a "city" — only districts — so this is a
// best-effort default the customer can overwrite: Delhi's districts are named
// after compass points ("South West"), and "Bengaluru Urban" is just Bengaluru.
const suggestCity = (district, state) => {
  if (state === "Delhi" && district !== "New Delhi") return "Delhi";
  return district.replace(/\s+Urban$/i, "");
};

/**
 * @param {string} pincode
 * @returns {{ pincode: string, district: string, state: string, city: string, localities: string[] } | null}
 */
export const lookupPincode = (pincode) => {
  const pin = String(pincode || "").trim();
  if (!INDIAN_PINCODE_REGEX.test(pin)) return null;

  const { pins, districts, states } = loadTable();
  const entry = pins[pin];
  if (!entry) return null;

  const [districtIndex, stateIndex, localities] = entry;
  const district = districts[districtIndex];
  const state = states[stateIndex];
  return { pincode: pin, district, state, city: suggestCity(district, state), localities };
};
