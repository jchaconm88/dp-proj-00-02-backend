export type CurrencyCode = "PEN" | "USD" | "EUR";

export interface CurrencyCatalogRecord {
  code: CurrencyCode;
  name: string;
  abbreviation: string;
  symbol: string;
  decimalDigits: number;
  formatLocale: string;
  readonly: true;
}

const CURRENCIES_CATALOG: CurrencyCatalogRecord[] = [
  { code: "PEN", name: "Sol peruano", abbreviation: "S/", symbol: "S/", decimalDigits: 2, formatLocale: "es-PE", readonly: true },
  { code: "USD", name: "Dolar estadounidense", abbreviation: "US$", symbol: "$", decimalDigits: 2, formatLocale: "en-US", readonly: true },
  { code: "EUR", name: "Euro", abbreviation: "EUR", symbol: "€", decimalDigits: 2, formatLocale: "es-ES", readonly: true },
];

function cloneCurrency(row: CurrencyCatalogRecord): CurrencyCatalogRecord {
  return { ...row };
}

export function getCurrenciesCatalog(): CurrencyCatalogRecord[] {
  return CURRENCIES_CATALOG.map(cloneCurrency).sort((a, b) => a.code.localeCompare(b.code));
}

export function parseCurrencyCode(raw: unknown): CurrencyCode | null {
  const normalized = String(raw ?? "").trim().toUpperCase();
  if (normalized === "PEN") return "PEN";
  if (normalized === "USD") return "USD";
  if (normalized === "EUR") return "EUR";
  return null;
}

export function getCurrencyByCode(raw: unknown): CurrencyCatalogRecord | null {
  const code = parseCurrencyCode(raw);
  if (!code) return null;
  const row = CURRENCIES_CATALOG.find((item) => item.code === code);
  return row ? cloneCurrency(row) : null;
}
