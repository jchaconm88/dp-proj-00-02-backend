import { parseCurrencyCode, type CurrencyCode } from "./currencies.js";

export type CountryCode = "PE";

export interface CountryCatalogRecord {
  code: CountryCode;
  name: string;
  allowedCurrencies: CurrencyCode[];
  defaultCurrency: CurrencyCode;
  readonly: true;
}

const COUNTRIES_CATALOG: CountryCatalogRecord[] = [
  { code: "PE", name: "Peru", allowedCurrencies: ["PEN", "USD", "EUR"], defaultCurrency: "PEN", readonly: true },
];

function cloneCountry(row: CountryCatalogRecord): CountryCatalogRecord {
  return {
    ...row,
    allowedCurrencies: [...row.allowedCurrencies],
  };
}

export function parseCountryCode(raw: unknown): CountryCode | null {
  const normalized = String(raw ?? "").trim().toUpperCase();
  if (normalized === "PE") return "PE";
  return null;
}

export function getCountryByCode(raw: unknown): CountryCatalogRecord | null {
  const code = parseCountryCode(raw);
  if (!code) return null;
  const row = COUNTRIES_CATALOG.find((item) => item.code === code);
  return row ? cloneCountry(row) : null;
}

export function getCountriesCatalog(): CountryCatalogRecord[] {
  return COUNTRIES_CATALOG.map(cloneCountry).sort((a, b) => a.code.localeCompare(b.code));
}

export function filterAllowedCurrenciesByCountry(
  countryRaw: unknown,
  currenciesRaw: unknown
): CurrencyCode[] | null {
  const country = getCountryByCode(countryRaw);
  if (!country) return null;
  const source = Array.isArray(currenciesRaw) ? currenciesRaw : [];
  const normalized = source
    .map((x) => parseCurrencyCode(x))
    .filter((x): x is CurrencyCode => x !== null);
  const unique = [...new Set(normalized)];
  const filtered = unique.filter((code) => country.allowedCurrencies.includes(code));
  return filtered.length ? filtered : null;
}
