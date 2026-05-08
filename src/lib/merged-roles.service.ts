import type { CatalogRoleRecord, MergedRoleRecord, RolePermissionsMap } from "../data/role-types.js";
import {
  getAdminRoleCatalogById,
  getAdminRolesCatalog,
  isAdminDefaultRoleId,
} from "../data/admin-roles.js";
import {
  getWebRoleCatalogById,
  getWebRolesCatalog,
  isWebDefaultRoleId,
} from "../data/web-roles.js";

export type RoleScope = "web" | "admin";

function normalizeRoleName(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function normalizePermissions(raw: unknown): RolePermissionsMap {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: RolePermissionsMap = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof key !== "string") continue;
    if (Array.isArray(value)) out[key] = value.filter((c): c is string => typeof c === "string");
  }
  return out;
}

function toMergedFromFirestore(
  id: string,
  data: FirebaseFirestore.DocumentData,
  source: "custom"
): MergedRoleRecord {
  return {
    id,
    companyId: String(data.companyId ?? "").trim() || undefined,
    accountId: String(data.accountId ?? "").trim() || undefined,
    name: String(data.name ?? "").trim(),
    description: String(data.description ?? "").trim(),
    permissions: normalizePermissions(data.permissions),
    permission: Array.isArray(data.permission) ? (data.permission as string[]).filter((x) => typeof x === "string") : [],
    source,
    readonly: false,
    platform: Array.isArray(data.platform) ? data.platform.map((x: unknown) => String(x)) : [],
    createBy: data.createBy != null ? String(data.createBy) : undefined,
    createAt: data.createAt ?? data.createdAt,
    updateBy: data.updateBy != null ? String(data.updateBy) : undefined,
    updateAt: data.updateAt ?? data.updatedAt,
  };
}

function toMergedFromCatalogWeb(row: CatalogRoleRecord, accountId: string, companyId: string): MergedRoleRecord {
  return {
    id: row.id,
    companyId,
    accountId,
    name: row.name,
    description: row.description,
    permissions: { ...row.permissions },
    permission: [...row.permission],
    source: "default",
    readonly: true,
    platform: ["web"],
  };
}

function toMergedFromCatalogAdmin(row: CatalogRoleRecord, accountId: string): MergedRoleRecord {
  return {
    id: row.id,
    accountId,
    name: row.name,
    description: row.description,
    permissions: { ...row.permissions },
    permission: [...row.permission],
    source: "default",
    readonly: true,
    platform: ["admin"],
  };
}

async function listFirestoreWebRoles(
  db: FirebaseFirestore.Firestore,
  accountId: string,
  companyId: string
): Promise<MergedRoleRecord[]> {
  const snap = await db
    .collection("roles")
    .where("companyId", "==", companyId)
    .where("accountId", "==", accountId)
    .get();
  return snap.docs.map((d) => toMergedFromFirestore(d.id, d.data() ?? {}, "custom"));
}

async function listFirestoreAdminRoles(
  db: FirebaseFirestore.Firestore,
  accountId: string
): Promise<MergedRoleRecord[]> {
  const snap = await db.collection("roles").where("accountId", "==", accountId).get();
  return snap.docs.map((d) => toMergedFromFirestore(d.id, d.data() ?? {}, "custom"));
}

export async function listMergedWebRoles(
  db: FirebaseFirestore.Firestore,
  accountId: string,
  companyId: string
): Promise<MergedRoleRecord[]> {
  const cid = String(companyId ?? "").trim();
  const aid = String(accountId ?? "").trim();
  if (!cid) throw new Error("companyId_required");
  const custom = await listFirestoreWebRoles(db, aid, cid);
  const byName = new Map(custom.map((r) => [normalizeRoleName(r.name), r]));
  const defaultNames = new Set(getWebRolesCatalog().map((r) => normalizeRoleName(r.name)));
  const merged: MergedRoleRecord[] = getWebRolesCatalog().map((row) => {
    const key = normalizeRoleName(row.name);
    const hit = byName.get(key);
    return hit ?? toMergedFromCatalogWeb(row, aid, cid);
  });
  for (const row of custom) {
    const key = normalizeRoleName(row.name);
    if (!defaultNames.has(key)) merged.push(row);
  }
  return merged.sort((a, b) => a.name.localeCompare(b.name));
}

export async function listMergedAdminRoles(
  db: FirebaseFirestore.Firestore,
  accountId: string
): Promise<MergedRoleRecord[]> {
  const aid = String(accountId ?? "").trim();
  const custom = await listFirestoreAdminRoles(db, aid);
  const byName = new Map(custom.map((r) => [normalizeRoleName(r.name), r]));
  const defaultNames = new Set(getAdminRolesCatalog().map((r) => normalizeRoleName(r.name)));
  const merged: MergedRoleRecord[] = getAdminRolesCatalog().map((row) => {
    const key = normalizeRoleName(row.name);
    const hit = byName.get(key);
    return hit ?? toMergedFromCatalogAdmin(row, aid);
  });
  for (const row of custom) {
    const key = normalizeRoleName(row.name);
    if (!defaultNames.has(key)) merged.push(row);
  }
  return merged.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getMergedWebRoleById(
  db: FirebaseFirestore.Firestore,
  accountId: string,
  companyId: string,
  id: string
): Promise<MergedRoleRecord | null> {
  const cid = String(companyId ?? "").trim();
  const aid = String(accountId ?? "").trim();
  if (isWebDefaultRoleId(id)) {
    const row = getWebRoleCatalogById(id);
    return row ? toMergedFromCatalogWeb(row, aid, cid) : null;
  }
  const snap = await db.collection("roles").doc(id).get();
  if (!snap.exists) return null;
  const data = snap.data() ?? {};
  if (String(data.companyId ?? "").trim() !== cid || String(data.accountId ?? "").trim() !== aid) return null;
  return toMergedFromFirestore(snap.id, data, "custom");
}

export async function getMergedAdminRoleById(
  db: FirebaseFirestore.Firestore,
  accountId: string,
  id: string
): Promise<MergedRoleRecord | null> {
  const aid = String(accountId ?? "").trim();
  if (isAdminDefaultRoleId(id)) {
    const row = getAdminRoleCatalogById(id);
    return row ? toMergedFromCatalogAdmin(row, aid) : null;
  }
  const snap = await db.collection("roles").doc(id).get();
  if (!snap.exists) return null;
  const data = snap.data() ?? {};
  if (String(data.accountId ?? "").trim() !== aid) return null;
  return toMergedFromFirestore(snap.id, data, "custom");
}

async function assertNoWebRoleNameDuplicate(
  db: FirebaseFirestore.Firestore,
  accountId: string,
  companyId: string,
  name: string,
  excludeDocId?: string
): Promise<void> {
  const merged = await listMergedWebRoles(db, accountId, companyId);
  const n = normalizeRoleName(name);
  const clash = merged.find((r) => normalizeRoleName(r.name) === n && r.id !== excludeDocId);
  if (clash) throw new Error("role_name_duplicate");
}

async function assertNoAdminRoleNameDuplicate(
  db: FirebaseFirestore.Firestore,
  accountId: string,
  name: string,
  excludeDocId?: string
): Promise<void> {
  const merged = await listMergedAdminRoles(db, accountId);
  const n = normalizeRoleName(name);
  const clash = merged.find((r) => normalizeRoleName(r.name) === n && r.id !== excludeDocId);
  if (clash) throw new Error("role_name_duplicate");
}

export async function createWebCustomRole(
  db: FirebaseFirestore.Firestore,
  accountId: string,
  companyId: string,
  body: Record<string, unknown>
): Promise<{ id: string }> {
  const cid = String(companyId ?? "").trim();
  const aid = String(accountId ?? "").trim();
  const name = String(body.name ?? "").trim();
  if (!name) throw new Error("name_required");
  await assertNoWebRoleNameDuplicate(db, aid, cid, name);
  const now = new Date();
  const permissions = normalizePermissions(body.permissions);
  const permission = Array.isArray(body.permission) ? (body.permission as unknown[]).filter((x): x is string => typeof x === "string") : [];
  const description = String(body.description ?? "").trim();
  const platform = Array.isArray(body.platform) ? (body.platform as unknown[]).filter((x): x is string => typeof x === "string") : [];
  const created = await db.collection("roles").add({
    companyId: cid,
    accountId: aid,
    name,
    description,
    permissions,
    permission,
    platform,
    createdAt: now,
    updateAt: now,
    createBy: body.createBy != null ? String(body.createBy) : "api",
    updateBy: body.updateBy != null ? String(body.updateBy) : "api",
  });
  return { id: created.id };
}

export async function updateWebCustomRole(
  db: FirebaseFirestore.Firestore,
  accountId: string,
  companyId: string,
  id: string,
  body: Record<string, unknown>
): Promise<void> {
  if (isWebDefaultRoleId(id)) throw new Error("default_role_readonly");
  const cid = String(companyId ?? "").trim();
  const aid = String(accountId ?? "").trim();
  const current = await getMergedWebRoleById(db, aid, cid, id);
  if (!current || current.source !== "custom") throw new Error("not_found");
  if (body.name !== undefined) {
    const nextName = String(body.name).trim();
    if (!nextName) throw new Error("name_required");
    await assertNoWebRoleNameDuplicate(db, aid, cid, nextName, id);
  }
  const patch: Record<string, unknown> = { updateAt: new Date(), updateBy: body.updateBy != null ? String(body.updateBy) : "api" };
  if (body.name !== undefined) patch.name = String(body.name).trim();
  if (body.description !== undefined) patch.description = String(body.description).trim();
  if (body.permissions !== undefined) patch.permissions = normalizePermissions(body.permissions);
  if (body.permission !== undefined) {
    patch.permission = Array.isArray(body.permission)
      ? (body.permission as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
  }
  if (body.platform !== undefined) {
    patch.platform = Array.isArray(body.platform)
      ? (body.platform as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
  }
  await db.collection("roles").doc(id).update(patch);
}

export async function deleteWebCustomRole(
  db: FirebaseFirestore.Firestore,
  accountId: string,
  companyId: string,
  id: string
): Promise<void> {
  if (isWebDefaultRoleId(id)) throw new Error("default_role_readonly");
  const current = await getMergedWebRoleById(db, accountId, companyId, id);
  if (!current || current.source !== "custom") throw new Error("not_found");
  await db.collection("roles").doc(id).delete();
}

export async function createAdminCustomRole(
  db: FirebaseFirestore.Firestore,
  accountId: string,
  body: Record<string, unknown>
): Promise<{ id: string }> {
  const aid = String(accountId ?? "").trim();
  const name = String(body.name ?? "").trim();
  if (!name) throw new Error("name_required");
  await assertNoAdminRoleNameDuplicate(db, aid, name);
  const now = new Date();
  const permissions = normalizePermissions(body.permissions);
  const permission = Array.isArray(body.permission) ? (body.permission as unknown[]).filter((x): x is string => typeof x === "string") : [];
  const description = String(body.description ?? "").trim();
  const platform = Array.isArray(body.platform) ? (body.platform as unknown[]).filter((x): x is string => typeof x === "string") : [];
  const created = await db.collection("roles").add({
    accountId: aid,
    name,
    description,
    permissions,
    permission,
    platform,
    createdAt: now,
    updatedAt: now,
  });
  return { id: created.id };
}

export async function updateAdminCustomRole(
  db: FirebaseFirestore.Firestore,
  accountId: string,
  id: string,
  body: Record<string, unknown>
): Promise<void> {
  if (isAdminDefaultRoleId(id)) throw new Error("default_role_readonly");
  const aid = String(accountId ?? "").trim();
  const current = await getMergedAdminRoleById(db, aid, id);
  if (!current || current.source !== "custom") throw new Error("not_found");
  if (body.name !== undefined) {
    const nextName = String(body.name).trim();
    if (!nextName) throw new Error("name_required");
    await assertNoAdminRoleNameDuplicate(db, aid, nextName, id);
  }
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (body.name !== undefined) patch.name = String(body.name).trim();
  if (body.description !== undefined) patch.description = String(body.description).trim();
  if (body.permissions !== undefined) patch.permissions = normalizePermissions(body.permissions);
  if (body.permission !== undefined) {
    patch.permission = Array.isArray(body.permission)
      ? (body.permission as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
  }
  if (body.platform !== undefined) {
    patch.platform = Array.isArray(body.platform)
      ? (body.platform as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
  }
  await db.collection("roles").doc(id).update(patch);
}

export async function deleteAdminCustomRole(
  db: FirebaseFirestore.Firestore,
  accountId: string,
  id: string
): Promise<void> {
  if (isAdminDefaultRoleId(id)) throw new Error("default_role_readonly");
  const current = await getMergedAdminRoleById(db, accountId, id);
  if (!current || current.source !== "custom") throw new Error("not_found");
  await db.collection("roles").doc(id).delete();
}

export function roleHttpStatus(error: string): number {
  if (error === "default_role_readonly" || error === "name_required" || error === "companyId_required") return 400;
  if (error === "role_name_duplicate") return 409;
  if (error === "not_found") return 404;
  return 500;
}
