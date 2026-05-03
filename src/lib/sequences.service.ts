import type { DefaultSequenceRecord, SequenceResetPeriod } from "../data/sequence-types.js";
import { getAdminSequenceByEntity, getAdminSequenceById, getAdminSequences } from "../data/admin-sequences.js";
import { getWebSequenceByEntity, getWebSequenceById, getWebSequences } from "../data/web-sequences.js";

export type SequenceScope = "admin" | "web";
export type SequenceSource = "default" | "custom";

export interface SequenceRecord {
  id: string;
  accountId?: string;
  companyId?: string;
  entity: string;
  prefix: string;
  digits: number;
  format: string;
  resetPeriod: SequenceResetPeriod;
  allowManualOverride: boolean;
  preventGaps: boolean;
  active: boolean;
  source: SequenceSource;
  readonly: boolean;
}

export interface SequencePayload {
  companyId?: string;
  entity?: string;
  prefix?: string;
  digits?: number;
  format?: string;
  resetPeriod?: SequenceResetPeriod;
  allowManualOverride?: boolean;
  preventGaps?: boolean;
  active?: boolean;
}

function customCollection(scope: SequenceScope): string {
  return "sequences";
}

function counterCollection(scope: SequenceScope): string {
  return "counters";
}

function isDefaultId(scope: SequenceScope, id: string): boolean {
  return String(id ?? "").startsWith(scope === "admin" ? "admin-default__" : "web-default__");
}

function defaultById(scope: SequenceScope, id: string): DefaultSequenceRecord | null {
  return scope === "admin" ? getAdminSequenceById(id) : getWebSequenceById(id);
}

function defaultByEntity(scope: SequenceScope, entity: string): DefaultSequenceRecord | null {
  return scope === "admin" ? getAdminSequenceByEntity(entity) : getWebSequenceByEntity(entity);
}

function defaults(scope: SequenceScope): DefaultSequenceRecord[] {
  return scope === "admin" ? getAdminSequences() : getWebSequences();
}

function normalizeResetPeriod(value: unknown): SequenceResetPeriod {
  const v = String(value ?? "").trim();
  return v === "yearly" || v === "monthly" || v === "daily" || v === "never" ? v : "yearly";
}

function toCustomRecord(id: string, data: FirebaseFirestore.DocumentData): SequenceRecord {
  return {
    id,
    accountId: String(data.accountId ?? "").trim() || undefined,
    companyId: String(data.companyId ?? "").trim() || undefined,
    entity: String(data.entity ?? "").trim(),
    prefix: String(data.prefix ?? "").trim(),
    digits: Number(data.digits) || 6,
    format: String(data.format ?? "{prefix}-{number}").trim() || "{prefix}-{number}",
    resetPeriod: normalizeResetPeriod(data.resetPeriod),
    allowManualOverride: data.allowManualOverride === true,
    preventGaps: data.preventGaps === true,
    active: data.active !== false,
    source: "custom",
    readonly: false,
  };
}

function toDefaultRecord(row: DefaultSequenceRecord): SequenceRecord {
  return { ...row, source: "default", readonly: true };
}

function queryForScope(
  db: FirebaseFirestore.Firestore,
  scope: SequenceScope,
  accountId: string,
  companyId?: string
): FirebaseFirestore.Query<FirebaseFirestore.DocumentData> {
  let q: FirebaseFirestore.Query<FirebaseFirestore.DocumentData> = db
    .collection(customCollection(scope))
    .where("accountId", "==", accountId);
  if (scope === "web") q = q.where("companyId", "==", String(companyId ?? "").trim());
  return q;
}

async function listCustomSequences(
  db: FirebaseFirestore.Firestore,
  scope: SequenceScope,
  accountId: string,
  companyId?: string
): Promise<SequenceRecord[]> {
  const snap = await queryForScope(db, scope, accountId, companyId).get();
  return snap.docs.map((doc) => toCustomRecord(doc.id, doc.data()));
}

export async function listMergedSequences(
  db: FirebaseFirestore.Firestore,
  scope: SequenceScope,
  accountId: string,
  companyId?: string
): Promise<SequenceRecord[]> {
  if (scope === "web" && !String(companyId ?? "").trim()) throw new Error("companyId_required");
  const custom = await listCustomSequences(db, scope, accountId, companyId);
  const byEntity = new Map(custom.map((s) => [s.entity, s]));
  const defaultEntities = new Set(defaults(scope).map((s) => s.entity));
  const merged = defaults(scope).map((s) => byEntity.get(s.entity) ?? toDefaultRecord(s));
  for (const row of custom) {
    if (!defaultEntities.has(row.entity)) merged.push(row);
  }
  return merged.sort((a, b) => a.entity.localeCompare(b.entity));
}

export async function getMergedSequenceById(
  db: FirebaseFirestore.Firestore,
  scope: SequenceScope,
  accountId: string,
  id: string,
  companyId?: string
): Promise<SequenceRecord | null> {
  if (isDefaultId(scope, id)) {
    const row = defaultById(scope, id);
    return row ? toDefaultRecord(row) : null;
  }
  const snap = await db.collection(customCollection(scope)).doc(id).get();
  if (!snap.exists) return null;
  const row = toCustomRecord(snap.id, snap.data() ?? {});
  if (row.accountId !== accountId) return null;
  if (scope === "web" && row.companyId !== String(companyId ?? "").trim()) return null;
  return row;
}

async function customByEntity(
  db: FirebaseFirestore.Firestore,
  scope: SequenceScope,
  accountId: string,
  entity: string,
  companyId?: string
): Promise<SequenceRecord | null> {
  let q = queryForScope(db, scope, accountId, companyId).where("entity", "==", entity).limit(1);
  const snap = await q.get();
  if (snap.empty) return null;
  const doc = snap.docs[0]!;
  return toCustomRecord(doc.id, doc.data());
}

export async function createCustomSequence(
  db: FirebaseFirestore.Firestore,
  scope: SequenceScope,
  accountId: string,
  data: SequencePayload,
  companyId?: string
): Promise<{ id: string }> {
  const entity = String(data.entity ?? "").trim();
  if (!entity) throw new Error("entity_required");
  if (scope === "web" && !String(companyId ?? data.companyId ?? "").trim()) throw new Error("companyId_required");
  const cid = scope === "web" ? String(companyId ?? data.companyId).trim() : undefined;
  const existing = await customByEntity(db, scope, accountId, entity, cid);
  if (existing) throw new Error("sequence_entity_duplicate");
  const now = new Date();
  const created = await db.collection(customCollection(scope)).add({
    accountId,
    ...(scope === "web" ? { companyId: cid } : {}),
    entity,
    prefix: String(data.prefix ?? "").trim(),
    digits: Number(data.digits) || 6,
    format: String(data.format ?? "{prefix}-{number}").trim() || "{prefix}-{number}",
    resetPeriod: normalizeResetPeriod(data.resetPeriod),
    allowManualOverride: data.allowManualOverride === true,
    preventGaps: data.preventGaps === true,
    active: data.active !== false,
    createdAt: now,
    updatedAt: now,
  });
  return { id: created.id };
}

export async function updateCustomSequence(
  db: FirebaseFirestore.Firestore,
  scope: SequenceScope,
  accountId: string,
  id: string,
  data: SequencePayload,
  companyId?: string
): Promise<void> {
  if (isDefaultId(scope, id)) throw new Error("default_sequence_readonly");
  const current = await getMergedSequenceById(db, scope, accountId, id, companyId);
  if (!current || current.source !== "custom") throw new Error("not_found");
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (data.entity !== undefined) {
    const entity = String(data.entity).trim();
    if (!entity) throw new Error("entity_required");
    if (entity !== current.entity) {
      const existing = await customByEntity(db, scope, accountId, entity, companyId);
      if (existing && existing.id !== id) throw new Error("sequence_entity_duplicate");
    }
    patch.entity = entity;
  }
  if (data.prefix !== undefined) patch.prefix = String(data.prefix).trim();
  if (data.digits !== undefined) patch.digits = Number(data.digits) || 6;
  if (data.format !== undefined) patch.format = String(data.format).trim() || "{prefix}-{number}";
  if (data.resetPeriod !== undefined) patch.resetPeriod = normalizeResetPeriod(data.resetPeriod);
  if (data.allowManualOverride !== undefined) patch.allowManualOverride = data.allowManualOverride === true;
  if (data.preventGaps !== undefined) patch.preventGaps = data.preventGaps === true;
  if (data.active !== undefined) patch.active = data.active !== false;
  await db.collection(customCollection(scope)).doc(id).update(patch);
}

export async function deleteCustomSequence(
  db: FirebaseFirestore.Firestore,
  scope: SequenceScope,
  accountId: string,
  id: string,
  companyId?: string
): Promise<void> {
  if (isDefaultId(scope, id)) throw new Error("default_sequence_readonly");
  const current = await getMergedSequenceById(db, scope, accountId, id, companyId);
  if (!current || current.source !== "custom") return;
  await db.collection(customCollection(scope)).doc(id).delete();
}

function currentPeriod(resetPeriod: SequenceResetPeriod): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  if (resetPeriod === "yearly") return String(y);
  if (resetPeriod === "monthly") return `${y}-${m}`;
  if (resetPeriod === "daily") return `${y}-${m}-${d}`;
  return "all";
}

function formatCode(sequence: SequenceRecord, nextNumber: number): string {
  const now = new Date();
  const number = String(nextNumber).padStart(Math.max(0, Number(sequence.digits) || 6), "0");
  return sequence.format
    .replace(/\{prefix\}/gi, sequence.prefix)
    .replace(/\{year\}/gi, String(now.getFullYear()))
    .replace(/\{month\}/gi, String(now.getMonth() + 1).padStart(2, "0"))
    .replace(/\{day\}/gi, String(now.getDate()).padStart(2, "0"))
    .replace(/\{number\}/gi, number);
}

function counterId(scope: SequenceScope, accountId: string, sequence: SequenceRecord, period: string, companyId?: string): string {
  const parts = scope === "web"
    ? [accountId, String(companyId ?? ""), sequence.id, period]
    : [accountId, sequence.id, period];
  return parts.map((p) => String(p).replace(/\//g, "-")).join("_");
}

export async function generateSequenceCode(
  db: FirebaseFirestore.Firestore,
  scope: SequenceScope,
  accountId: string,
  entity: string,
  currentCode: string,
  companyId?: string
): Promise<string> {
  const trimmed = String(currentCode ?? "").trim();
  if (trimmed) return trimmed;
  const normalizedEntity = String(entity ?? "").trim();
  if (!normalizedEntity) throw new Error("entity_required");
  const custom = await customByEntity(db, scope, accountId, normalizedEntity, companyId);
  const sequence = custom && custom.active !== false
    ? custom
    : (() => {
        const row = defaultByEntity(scope, normalizedEntity);
        return row ? toDefaultRecord(row) : null;
      })();
  if (!sequence || sequence.active === false) throw new Error("sequence_not_found");
  const period = currentPeriod(sequence.resetPeriod);
  const id = counterId(scope, accountId, sequence, period, companyId);
  const next = await db.runTransaction(async (tx) => {
    const ref = db.collection(counterCollection(scope)).doc(id);
    const snap = await tx.get(ref);
    const last = snap.exists ? Number(snap.data()?.lastNumber ?? 0) || 0 : 0;
    const value = last + 1;
    tx.set(ref, {
      accountId,
      ...(scope === "web" ? { companyId: String(companyId ?? "").trim() } : {}),
      sequenceId: sequence.id,
      sequenceSource: sequence.source,
      entity: sequence.entity,
      period,
      lastNumber: value,
      updatedAt: new Date(),
      ...(snap.exists ? {} : { createdAt: new Date() }),
    }, { merge: true });
    return value;
  });
  return formatCode(sequence, next);
}
