import type { firestore as FirebaseFirestore } from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";

const COLLECTION = "entity-search-indexes-admin";

export interface AdminEntitySearchIndexParams {
  accountId: string;
  entityId: string;
  action: "create" | "update" | "delete";
  recordId: string;
  fields: Record<string, string | undefined>;
}

function normalizeFieldsForIndex(
  fields: Record<string, string | undefined>
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    const str = String(value ?? "");
    normalized[key] = str
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
  }
  return normalized;
}

export async function updateAdminEntitySearchIndex(
  db: FirebaseFirestore.Firestore,
  params: AdminEntitySearchIndexParams
): Promise<void> {
  const { accountId, entityId, action, recordId, fields } = params;

  if (!entityId || !recordId) {
    console.warn("[admin/entity-search-index] missing required fields", { entityId, recordId });
    return;
  }

  try {
    const docRef = db.collection(COLLECTION).doc(accountId);

    if (action === "delete") {
      const deletePath = `entities.${entityId}.${recordId}`;
      await docRef.update({
        [deletePath]: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    } else {
      const cleanFields: Record<string, string> = {};
      for (const [key, value] of Object.entries(fields)) {
        cleanFields[key] = String(value ?? "");
      }
      const setPath = `entities.${entityId}.${recordId}`;
      await docRef.set(
        {
          accountId,
          [setPath]: {
            fields: cleanFields,
            fieldsNormalized: normalizeFieldsForIndex(cleanFields),
          },
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }
  } catch (error) {
    console.error("[admin/entity-search-index] update failed:", error);
  }
}

type IndexRecord = {
  fields: Record<string, string>;
  fieldsNormalized: Record<string, string>;
};

export type RebuildSummary = Record<string, number>;

function buildIndexRecord(fields: Record<string, string | undefined>): IndexRecord {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    clean[key] = String(value ?? "");
  }
  return {
    fields: clean,
    fieldsNormalized: normalizeFieldsForIndex(clean),
  };
}

export async function rebuildAdminEntitySearchIndexForAccount(
  adminDb: FirebaseFirestore.Firestore,
  webDb: FirebaseFirestore.Firestore,
  params: { accountId: string }
): Promise<RebuildSummary> {
  const { accountId } = params;
  const entities: Record<string, Record<string, IndexRecord>> = {
    account: {},
    company: {},
    "admin-user": {},
    subscription: {},
    plan: {},
    role: {},
    "company-user": {},
    "web-user": {},
  };

  const [
    accountSnap,
    companiesSnap,
    adminUsersSnap,
    plansSnap,
    subscriptionsSnap,
    rolesSnap,
    companyUsersSnap,
    webUsersSnap,
  ] = await Promise.all([
    adminDb.collection("accounts").doc(accountId).get(),
    webDb.collection("companies").where("accountId", "==", accountId).get(),
    adminDb.collection("users").where("accountId", "==", accountId).where("platform", "array-contains", "admin").get(),
    adminDb.collection("saas-plans").where("accountId", "==", accountId).get(),
    adminDb.collection("subscriptions").where("accountId", "==", accountId).get(),
    adminDb.collection("roles").where("accountId", "==", accountId).get(),
    webDb.collection("company-users").where("accountId", "==", accountId).get(),
    webDb.collection("users").where("accountId", "==", accountId).where("platform", "array-contains", "web").get(),
  ]);

  if (accountSnap.exists) {
    const row = accountSnap.data() ?? {};
    entities.account[accountId] = buildIndexRecord({
      name: String(row.name ?? ""),
      status: String(row.status ?? ""),
    });
  }

  for (const d of companiesSnap.docs) {
    const row = d.data() ?? {};
    entities.company[d.id] = buildIndexRecord({
      name: String(row.name ?? ""),
      ruc: String(row.taxId ?? ""),
      status: String(row.status ?? ""),
    });
  }

  for (const d of adminUsersSnap.docs) {
    const row = d.data() ?? {};
    entities["admin-user"][d.id] = buildIndexRecord({
      displayName: String(row.displayName ?? ""),
      email: String(row.email ?? ""),
      status: String(row.status ?? ""),
    });
  }

  for (const d of plansSnap.docs) {
    const row = d.data() ?? {};
    entities.plan[d.id] = buildIndexRecord({
      name: String(row.name ?? ""),
    });
  }

  for (const d of subscriptionsSnap.docs) {
    const row = d.data() ?? {};
    entities.subscription[d.id] = buildIndexRecord({
      planId: String(row.planId ?? ""),
      status: String(row.status ?? ""),
    });
  }

  for (const d of rolesSnap.docs) {
    const row = d.data() ?? {};
    entities.role[d.id] = buildIndexRecord({
      name: String(row.name ?? ""),
      description: String(row.description ?? ""),
    });
  }

  for (const d of companyUsersSnap.docs) {
    const row = d.data() ?? {};
    entities["company-user"][d.id] = buildIndexRecord({
      displayName: String(row.userDisplayName ?? ""),
      email: String(row.userEmail ?? ""),
      userId: String(row.userId ?? ""),
      status: String(row.status ?? ""),
    });
  }

  for (const d of webUsersSnap.docs) {
    const row = d.data() ?? {};
    entities["web-user"][d.id] = buildIndexRecord({
      displayName: String(row.displayName ?? ""),
      email: String(row.email ?? ""),
      status: String(row.status ?? ""),
    });
  }

  const summary: RebuildSummary = Object.fromEntries(
    Object.entries(entities).map(([k, v]) => [k, Object.keys(v).length])
  );

  await adminDb.collection(COLLECTION).doc(accountId).set(
    {
      accountId,
      entities,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: false }
  );

  return summary;
}
