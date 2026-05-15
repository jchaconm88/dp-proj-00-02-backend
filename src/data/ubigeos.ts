export type UbigeoCountryCode = "PE";
export type UbigeoCode = string;

export interface UbigeoCatalogRecord {
  code: UbigeoCode;
  name: string;
  country: UbigeoCountryCode;
  readonly: true;
}

const UBIGEOS_CATALOG: UbigeoCatalogRecord[] = [
  { code: "010101", name: "Chachapoyas — Chachapoyas — Amazonas", country: "PE", readonly: true },
  { code: "020101", name: "Huaraz — Huaraz — Áncash", country: "PE", readonly: true },
  { code: "030101", name: "Abancay — Abancay — Apurímac", country: "PE", readonly: true },
  { code: "040101", name: "Arequipa — Arequipa — Arequipa", country: "PE", readonly: true },
  { code: "050101", name: "Ayacucho — Huamanga — Ayacucho", country: "PE", readonly: true },
  { code: "060101", name: "Cajamarca — Cajamarca — Cajamarca", country: "PE", readonly: true },
  { code: "070101", name: "Callao — Callao — Callao", country: "PE", readonly: true },
  { code: "070102", name: "Bellavista — Callao — Callao", country: "PE", readonly: true },
  { code: "070103", name: "Carmen de la Legua Reynoso — Callao — Callao", country: "PE", readonly: true },
  { code: "070104", name: "La Perla — Callao — Callao", country: "PE", readonly: true },
  { code: "070105", name: "La Punta — Callao — Callao", country: "PE", readonly: true },
  { code: "070106", name: "Ventanilla — Callao — Callao", country: "PE", readonly: true },
  { code: "070107", name: "Mi Perú — Callao — Callao", country: "PE", readonly: true },
  { code: "080101", name: "Cusco — Cusco — Cusco", country: "PE", readonly: true },
  { code: "080102", name: "Wanchaq — Cusco — Cusco", country: "PE", readonly: true },
  { code: "080103", name: "Santiago — Cusco — Cusco", country: "PE", readonly: true },
  { code: "090101", name: "Huancavelica — Huancavelica — Huancavelica", country: "PE", readonly: true },
  { code: "100101", name: "Huánuco — Huánuco — Huánuco", country: "PE", readonly: true },
  { code: "110101", name: "Ica — Ica — Ica", country: "PE", readonly: true },
  { code: "110102", name: "La Tinguiña — Ica — Ica", country: "PE", readonly: true },
  { code: "110103", name: "Los Aquijes — Ica — Ica", country: "PE", readonly: true },
  { code: "110104", name: "Ocucaje — Ica — Ica", country: "PE", readonly: true },
  { code: "110105", name: "Pachacútec — Ica — Ica", country: "PE", readonly: true },
  { code: "110106", name: "Parcona — Ica — Ica", country: "PE", readonly: true },
  { code: "110107", name: "Pueblo Nuevo — Ica — Ica", country: "PE", readonly: true },
  { code: "110108", name: "Salas — Ica — Ica", country: "PE", readonly: true },
  { code: "110109", name: "San José de los Molinos — Ica — Ica", country: "PE", readonly: true },
  { code: "110110", name: "San Juan Bautista — Ica — Ica", country: "PE", readonly: true },
  { code: "110111", name: "Santiago — Ica — Ica", country: "PE", readonly: true },
  { code: "110112", name: "Subtanjalla — Ica — Ica", country: "PE", readonly: true },
  { code: "110113", name: "Tate — Ica — Ica", country: "PE", readonly: true },
  { code: "110114", name: "Yauca del Rosario — Ica — Ica", country: "PE", readonly: true },
  { code: "120101", name: "Huancayo — Huancayo — Junín", country: "PE", readonly: true },
  { code: "130101", name: "Trujillo — Trujillo — La Libertad", country: "PE", readonly: true },
  { code: "130102", name: "El Porvenir — Trujillo — La Libertad", country: "PE", readonly: true },
  { code: "130103", name: "Florencia de Mora — Trujillo — La Libertad", country: "PE", readonly: true },
  { code: "130104", name: "Huanchaco — Trujillo — La Libertad", country: "PE", readonly: true },
  { code: "130105", name: "La Esperanza — Trujillo — La Libertad", country: "PE", readonly: true },
  { code: "130106", name: "Laredo — Trujillo — La Libertad", country: "PE", readonly: true },
  { code: "130107", name: "Moche — Trujillo — La Libertad", country: "PE", readonly: true },
  { code: "130108", name: "Poroto — Trujillo — La Libertad", country: "PE", readonly: true },
  { code: "130109", name: "Salaverry — Trujillo — La Libertad", country: "PE", readonly: true },
  { code: "130110", name: "Simbal — Trujillo — La Libertad", country: "PE", readonly: true },
  { code: "130111", name: "Victor Larco Herrera — Trujillo — La Libertad", country: "PE", readonly: true },
  { code: "140101", name: "Chiclayo — Chiclayo — Lambayeque", country: "PE", readonly: true },
  { code: "140102", name: "Chongoyape — Chiclayo — Lambayeque", country: "PE", readonly: true },
  { code: "140103", name: "Eten — Chiclayo — Lambayeque", country: "PE", readonly: true },
  { code: "140104", name: "Eten Puerto — Chiclayo — Lambayeque", country: "PE", readonly: true },
  { code: "140105", name: "José Leonardo Ortiz — Chiclayo — Lambayeque", country: "PE", readonly: true },
  { code: "140106", name: "La Victoria — Chiclayo — Lambayeque", country: "PE", readonly: true },
  { code: "140107", name: "Lagunas — Chiclayo — Lambayeque", country: "PE", readonly: true },
  { code: "140108", name: "Monsefú — Chiclayo — Lambayeque", country: "PE", readonly: true },
  { code: "140109", name: "Nueva Arica — Chiclayo — Lambayeque", country: "PE", readonly: true },
  { code: "140110", name: "Oyotún — Chiclayo — Lambayeque", country: "PE", readonly: true },
  { code: "140111", name: "Pátapo — Chiclayo — Lambayeque", country: "PE", readonly: true },
  { code: "140112", name: "Picsi — Chiclayo — Lambayeque", country: "PE", readonly: true },
  { code: "140113", name: "Pimentel — Chiclayo — Lambayeque", country: "PE", readonly: true },
  { code: "140114", name: "Reque — Chiclayo — Lambayeque", country: "PE", readonly: true },
  { code: "140115", name: "Santa Rosa — Chiclayo — Lambayeque", country: "PE", readonly: true },
  { code: "140116", name: "Saña — Chiclayo — Lambayeque", country: "PE", readonly: true },
  { code: "140117", name: "Cayaltí — Chiclayo — Lambayeque", country: "PE", readonly: true },
  { code: "140118", name: "Chóchope — Chiclayo — Lambayeque", country: "PE", readonly: true },
  { code: "140119", name: "Íllimo — Chiclayo — Lambayeque", country: "PE", readonly: true },
  { code: "140120", name: "Jayanca — Chiclayo — Lambayeque", country: "PE", readonly: true },
  { code: "140121", name: "Mórrope — Chiclayo — Lambayeque", country: "PE", readonly: true },
  { code: "140122", name: "Motupe — Chiclayo — Lambayeque", country: "PE", readonly: true },
  { code: "140123", name: "Olmos — Chiclayo — Lambayeque", country: "PE", readonly: true },
  { code: "140124", name: "Pacora — Chiclayo — Lambayeque", country: "PE", readonly: true },
  { code: "140125", name: "Salas — Chiclayo — Lambayeque", country: "PE", readonly: true },
  { code: "140126", name: "San José — Chiclayo — Lambayeque", country: "PE", readonly: true },
  { code: "140127", name: "Túcume — Chiclayo — Lambayeque", country: "PE", readonly: true },
  { code: "150101", name: "Lima — Lima — Lima", country: "PE", readonly: true },
  { code: "150102", name: "Ancón — Lima — Lima", country: "PE", readonly: true },
  { code: "150103", name: "Ate — Lima — Lima", country: "PE", readonly: true },
  { code: "150104", name: "Barranco — Lima — Lima", country: "PE", readonly: true },
  { code: "150105", name: "Breña — Lima — Lima", country: "PE", readonly: true },
  { code: "150106", name: "Carabayllo — Lima — Lima", country: "PE", readonly: true },
  { code: "150107", name: "Chaclacayo — Lima — Lima", country: "PE", readonly: true },
  { code: "150108", name: "Chorrillos — Lima — Lima", country: "PE", readonly: true },
  { code: "150109", name: "Cieneguilla — Lima — Lima", country: "PE", readonly: true },
  { code: "150110", name: "Comas — Lima — Lima", country: "PE", readonly: true },
  { code: "150111", name: "El Agustino — Lima — Lima", country: "PE", readonly: true },
  { code: "150112", name: "Independencia — Lima — Lima", country: "PE", readonly: true },
  { code: "150113", name: "Jesús María — Lima — Lima", country: "PE", readonly: true },
  { code: "150114", name: "La Molina — Lima — Lima", country: "PE", readonly: true },
  { code: "150115", name: "La Victoria — Lima — Lima", country: "PE", readonly: true },
  { code: "150116", name: "Lince — Lima — Lima", country: "PE", readonly: true },
  { code: "150117", name: "Los Olivos — Lima — Lima", country: "PE", readonly: true },
  { code: "150118", name: "Lurigancho (Chosica) — Lima — Lima", country: "PE", readonly: true },
  { code: "150119", name: "Lurín — Lima — Lima", country: "PE", readonly: true },
  { code: "150120", name: "Magdalena del Mar — Lima — Lima", country: "PE", readonly: true },
  { code: "150121", name: "Miraflores — Lima — Lima", country: "PE", readonly: true },
  { code: "150122", name: "Pachacamac — Lima — Lima", country: "PE", readonly: true },
  { code: "150123", name: "Pucusana — Lima — Lima", country: "PE", readonly: true },
  { code: "150124", name: "Puente Piedra — Lima — Lima", country: "PE", readonly: true },
  { code: "150125", name: "Punta Hermosa — Lima — Lima", country: "PE", readonly: true },
  { code: "150126", name: "Punta Negra — Lima — Lima", country: "PE", readonly: true },
  { code: "150127", name: "Rímac — Lima — Lima", country: "PE", readonly: true },
  { code: "150128", name: "San Bartolo — Lima — Lima", country: "PE", readonly: true },
  { code: "150129", name: "San Borja — Lima — Lima", country: "PE", readonly: true },
  { code: "150130", name: "San Isidro — Lima — Lima", country: "PE", readonly: true },
  { code: "150131", name: "San Juan de Lurigancho — Lima — Lima", country: "PE", readonly: true },
  { code: "150132", name: "San Juan de Miraflores — Lima — Lima", country: "PE", readonly: true },
  { code: "150133", name: "San Luis — Lima — Lima", country: "PE", readonly: true },
  { code: "150134", name: "San Martín de Porres — Lima — Lima", country: "PE", readonly: true },
  { code: "150135", name: "San Miguel — Lima — Lima", country: "PE", readonly: true },
  { code: "150136", name: "Santa Anita — Lima — Lima", country: "PE", readonly: true },
  { code: "150137", name: "Santa María del Mar — Lima — Lima", country: "PE", readonly: true },
  { code: "150138", name: "Santa Rosa — Lima — Lima", country: "PE", readonly: true },
  { code: "150139", name: "Santiago de Surco — Lima — Lima", country: "PE", readonly: true },
  { code: "150140", name: "Surquillo — Lima — Lima", country: "PE", readonly: true },
  { code: "150141", name: "Villa El Salvador — Lima — Lima", country: "PE", readonly: true },
  { code: "150142", name: "Villa María del Triunfo — Lima — Lima", country: "PE", readonly: true },
  { code: "160101", name: "Iquitos — Maynas — Loreto", country: "PE", readonly: true },
  { code: "170101", name: "Tambopata — Tambopata — Madre de Dios", country: "PE", readonly: true },
  { code: "170102", name: "Inambari — Tambopata — Madre de Dios", country: "PE", readonly: true },
  { code: "170103", name: "Las Piedras — Tambopata — Madre de Dios", country: "PE", readonly: true },
  { code: "170104", name: "Laberinto — Tambopata — Madre de Dios", country: "PE", readonly: true },
  { code: "180101", name: "Mariscal Nieto — Mariscal Nieto — Moquegua", country: "PE", readonly: true },
  { code: "190101", name: "Chaupimarca — Pasco — Pasco", country: "PE", readonly: true },
  { code: "200101", name: "Piura — Piura — Piura", country: "PE", readonly: true },
  { code: "200102", name: "Castilla — Piura — Piura", country: "PE", readonly: true },
  { code: "200103", name: "Catacaos — Piura — Piura", country: "PE", readonly: true },
  { code: "200104", name: "Cura Morropón — Piura — Piura", country: "PE", readonly: true },
  { code: "200105", name: "El Tallán — Piura — Piura", country: "PE", readonly: true },
  { code: "200106", name: "La Arena — Piura — Piura", country: "PE", readonly: true },
  { code: "200107", name: "La Unión — Piura — Piura", country: "PE", readonly: true },
  { code: "200108", name: "Las Lomas — Piura — Piura", country: "PE", readonly: true },
  { code: "200109", name: "Tambo Grande — Piura — Piura", country: "PE", readonly: true },
  { code: "200110", name: "Veintiséis de Octubre — Piura — Piura", country: "PE", readonly: true },
  { code: "210101", name: "Puno — Puno — Puno", country: "PE", readonly: true },
  { code: "220101", name: "Moyobamba — Moyobamba — San Martín", country: "PE", readonly: true },
  { code: "230101", name: "Tacna — Tacna — Tacna", country: "PE", readonly: true },
  { code: "240101", name: "Tumbes — Tumbes — Tumbes", country: "PE", readonly: true },
  { code: "250101", name: "Callería — Coronel Portillo — Ucayali", country: "PE", readonly: true },
];

function cloneUbigeo(row: UbigeoCatalogRecord): UbigeoCatalogRecord {
  return { ...row };
}

export function parseUbigeoCountry(raw: unknown): UbigeoCountryCode | null {
  const normalized = String(raw ?? "").trim().toUpperCase();
  if (normalized === "PE") return "PE";
  return null;
}

export function parseUbigeoCode(raw: unknown): UbigeoCode | null {
  const normalized = String(raw ?? "").trim();
  return /^\d{6}$/.test(normalized) ? normalized : null;
}

export function getUbigeosByCountry(countryRaw: unknown): UbigeoCatalogRecord[] {
  const country = parseUbigeoCountry(countryRaw);
  if (!country) return [];
  return UBIGEOS_CATALOG
    .filter((row) => row.country === country)
    .map(cloneUbigeo)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getUbigeoByCodeAndCountry(
  codeRaw: unknown,
  countryRaw: unknown
): UbigeoCatalogRecord | null {
  const code = parseUbigeoCode(codeRaw);
  const country = parseUbigeoCountry(countryRaw);
  if (!code || !country) return null;
  const row = UBIGEOS_CATALOG.find((item) => item.code === code && item.country === country);
  return row ? cloneUbigeo(row) : null;
}

export function listUbigeos(countryRaw: unknown): UbigeoCatalogRecord[] {
  return getUbigeosByCountry(countryRaw);
}

export function getUbigeoByCode(codeRaw: unknown, countryRaw: unknown = "PE"): UbigeoCatalogRecord | null {
  return getUbigeoByCodeAndCountry(codeRaw, countryRaw);
}

export function ubigeoToSelectOptions(
  countryRaw: unknown
): Array<{ label: string; value: UbigeoCode }> {
  return getUbigeosByCountry(countryRaw).map((row) => ({
    label: `${row.name} (${row.code})`,
    value: row.code,
  }));
}
