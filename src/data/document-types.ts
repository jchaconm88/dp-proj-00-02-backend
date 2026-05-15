export type DocumentTypeCountry = "PE";
export type DocumentTypeCategory = "identity" | "billing";

export interface DocumentTypeCatalogRecord {
  id: string;
  code: string;
  name: string;
  description: string;
  country: DocumentTypeCountry;
  type: DocumentTypeCategory;
  readonly: true;
}

const DOCUMENT_TYPES_CATALOG: DocumentTypeCatalogRecord[] = [
  // Identity (PE)
  { id: "pe-identity-dni", code: "DNI", name: "DNI", description: "Documento Nacional de Identidad", country: "PE", type: "identity", readonly: true },
  { id: "pe-identity-ruc", code: "RUC", name: "RUC", description: "Registro Unico de Contribuyentes", country: "PE", type: "identity", readonly: true },
  { id: "pe-identity-ce", code: "CE", name: "Carnet de Extranjeria", description: "Carnet de Extranjeria", country: "PE", type: "identity", readonly: true },
  { id: "pe-identity-passport", code: "PASAPORTE", name: "Pasaporte", description: "Pasaporte", country: "PE", type: "identity", readonly: true },
  // Billing (PE)
  { id: "pe-billing-invoice", code: "FACTURA", name: "Factura", description: "Comprobante de pago tipo factura", country: "PE", type: "billing", readonly: true },
  { id: "pe-billing-receipt", code: "BOLETA", name: "Boleta", description: "Comprobante de pago tipo boleta", country: "PE", type: "billing", readonly: true },
  { id: "pe-billing-credit-note", code: "NOTA_CREDITO", name: "Nota de credito", description: "Nota de credito", country: "PE", type: "billing", readonly: true },
  { id: "pe-billing-debit-note", code: "NOTA_DEBITO", name: "Nota de debito", description: "Nota de debito", country: "PE", type: "billing", readonly: true },
  { id: "pe-billing-dispatch-guide", code: "GUIA_REMISION", name: "Guia de remision", description: "Guia de remision", country: "PE", type: "billing", readonly: true },
];

function cloneDocumentType(row: DocumentTypeCatalogRecord): DocumentTypeCatalogRecord {
  return { ...row };
}

export function parseDocumentTypeCountry(raw: unknown): DocumentTypeCountry {
  const normalized = String(raw ?? "").trim().toUpperCase();
  return normalized === "PE" ? "PE" : "PE";
}

export function parseDocumentTypeCategory(raw: unknown): DocumentTypeCategory | null {
  const normalized = String(raw ?? "").trim().toLowerCase();
  if (normalized === "identity") return "identity";
  if (normalized === "billing") return "billing";
  return null;
}

export function getDocumentTypesByCountryAndType(
  countryRaw: unknown,
  categoryRaw: unknown
): DocumentTypeCatalogRecord[] {
  const country = parseDocumentTypeCountry(countryRaw);
  const category = parseDocumentTypeCategory(categoryRaw);
  if (!category) return [];
  return DOCUMENT_TYPES_CATALOG
    .filter((row) => row.country === country && row.type === category)
    .map(cloneDocumentType)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getDocumentTypeByIdAndScope(
  idRaw: unknown,
  countryRaw: unknown,
  categoryRaw: unknown
): DocumentTypeCatalogRecord | null {
  const id = String(idRaw ?? "").trim();
  const country = parseDocumentTypeCountry(countryRaw);
  const category = parseDocumentTypeCategory(categoryRaw);
  if (!id || !category) return null;
  const row = DOCUMENT_TYPES_CATALOG.find(
    (item) => item.id === id && item.country === country && item.type === category
  );
  return row ? cloneDocumentType(row) : null;
}
