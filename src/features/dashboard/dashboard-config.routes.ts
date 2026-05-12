import { Router } from "express";
import type { Request, Response } from "express";
import { getWebFirestore, getAdminFirestore } from "../../lib/firebase-admin.js";
import { getAdminRolesCatalog } from "../../data/admin-roles.js";
import {
  listMetrics,
  createMetric,
  updateMetric,
  deleteMetric,
  listCards,
  createCard,
  updateCard,
  deleteCard,
  listCharts,
  createChart,
  updateChart,
  deleteChart,
} from "./dashboard-config.service.js";
import { listMergedCards, listMergedCharts } from "./dashboard-catalog.service.js";

// ─── Permission Helper ───────────────────────────────────────────────────────

/**
 * Resolves effective permissions from admin roles and checks for a specific
 * `dashboard-config:{action}` permission.
 */
async function resolveEffectivePermissions(req: Request): Promise<string[]> {
  const admin = (req as any).admin as
    | { adminRoleIds?: string[]; adminRoleNames?: string[] }
    | undefined;
  if (!admin) return [];

  const roleIds = Array.isArray(admin.adminRoleIds) ? admin.adminRoleIds : [];
  const roleNames = Array.isArray(admin.adminRoleNames) ? admin.adminRoleNames : [];

  if (roleIds.length === 0 && roleNames.length === 0) return [];

  const db = getAdminFirestore();
  const rolesSnap = await db.collection("admin-roles").get();
  const allRoles = rolesSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() })) as Array<{
    id: string;
    name?: string;
    permissions?: Record<string, string[]>;
    permission?: string[];
  }>;

  // Include default catalog roles (may not be persisted in Firestore)
  for (const cr of getAdminRolesCatalog()) {
    if (!allRoles.some((r) => r.id === cr.id || r.name?.toLowerCase() === cr.name.toLowerCase())) {
      allRoles.push({ id: cr.id, name: cr.name, permissions: cr.permissions, permission: cr.permission });
    }
  }

  const set = new Set<string>();
  const roleMap = new Map(allRoles.map((r) => [r.id, r]));
  const byName = new Map(allRoles.map((r) => [String(r.name ?? "").toLowerCase(), r]));

  function collectFromRole(role: typeof allRoles[number]): void {
    // Process legacy `permission` array (e.g. ["view", "create", ...])
    if (Array.isArray(role.permission)) {
      for (const legacy of role.permission) {
        const code = String(legacy ?? "").trim().toLowerCase();
        if (!code) continue;
        if (code === "*") { set.add("*"); return; }
        if (!code.includes(":")) {
          set.add(`*:${code}`);
        } else {
          set.add(code);
        }
      }
    }

    // Process `permissions` map (e.g. { "dashboard-config": ["view","create"], "*": ["*"] })
    if (role.permissions && typeof role.permissions === "object") {
      for (const [mod, actions] of Object.entries(role.permissions)) {
        const moduleName = String(mod).trim().toLowerCase();
        if (!Array.isArray(actions) || actions.length === 0) continue;
        for (const actionRaw of actions) {
          const action = String(actionRaw).trim().toLowerCase();
          if (!action) continue;
          if (moduleName === "*" && action === "*") { set.add("*"); return; }
          if (action === "*") {
            set.add(`*:${moduleName}`);
          } else {
            set.add(`${moduleName}:${action}`);
          }
        }
      }
    }
  }

  for (const rid of roleIds) {
    const role = roleMap.get(rid) ?? byName.get(rid.toLowerCase());
    if (role) collectFromRole(role);
    if (set.has("*")) return ["*"];
  }

  for (const rName of roleNames) {
    const role = byName.get(rName.toLowerCase());
    if (role) collectFromRole(role);
    if (set.has("*")) return ["*"];
  }

  return Array.from(set);
}

async function hasPermission(req: Request, action: string, module = "dashboard-config"): Promise<boolean> {
  const perms = await resolveEffectivePermissions(req);
  if (perms.includes("*")) return true;
  return perms.includes(`${module}:${action}`) || perms.includes(`*:${module}`);
}

// ─── Error Handler ───────────────────────────────────────────────────────────

function handleServiceError(err: unknown, res: Response): void {
  const message = err instanceof Error ? err.message : "unknown_error";

  if (message.includes("Validation failed")) {
    res.status(422).json({ error: "validation_failed", message });
    return;
  }
  if (message.includes("solo lectura") || message.includes("readonly")) {
    res.status(400).json({ error: "readonly", message });
    return;
  }
  if (message.includes("referenciada") || message.includes("referenced")) {
    res.status(409).json({ error: "conflict", message });
    return;
  }
  if (message.includes("not found")) {
    res.status(404).json({ error: "not_found", message });
    return;
  }

  console.error("[dashboard-config.routes] unhandled error:", message);
  res.status(500).json({ error: "internal", message });
}

// ─── Router ──────────────────────────────────────────────────────────────────

const router = Router();

// ─── Metrics ─────────────────────────────────────────────────────────────────

router.get("/metrics", async (req, res) => {
  try {
    if (!(await hasPermission(req, "view", "dashboard-metrics"))) {
      return res.status(403).json({ error: "forbidden" });
    }
    const db = getWebFirestore();
    const items = await listMetrics(db);

    // Optional target filter: ?target=admin|web
    const targetQuery = String(req.query?.target ?? "").trim();
    if (targetQuery === "admin" || targetQuery === "web") {
      const filtered = items.filter(
        (m) => {
          const t = (m.data as any).target;
          return t === targetQuery || t === "both";
        }
      );
      return res.status(200).json(filtered);
    }

    res.status(200).json(items);
  } catch (err) {
    handleServiceError(err, res);
  }
});

router.post("/metrics", async (req, res) => {
  try {
    if (!(await hasPermission(req, "create", "dashboard-metrics"))) {
      return res.status(403).json({ error: "forbidden" });
    }
    const db = getWebFirestore();
    const result = await createMetric(db, req.body);
    res.status(201).json(result);
  } catch (err) {
    handleServiceError(err, res);
  }
});

router.put("/metrics/:id", async (req, res) => {
  try {
    if (!(await hasPermission(req, "edit", "dashboard-metrics"))) {
      return res.status(403).json({ error: "forbidden" });
    }
    const db = getWebFirestore();
    await updateMetric(db, req.params.id, req.body);
    res.status(200).json({ ok: true });
  } catch (err) {
    handleServiceError(err, res);
  }
});

router.delete("/metrics/:id", async (req, res) => {
  try {
    if (!(await hasPermission(req, "delete", "dashboard-metrics"))) {
      return res.status(403).json({ error: "forbidden" });
    }
    const db = getWebFirestore();
    await deleteMetric(db, req.params.id);
    res.status(200).json({ ok: true });
  } catch (err) {
    handleServiceError(err, res);
  }
});

// ─── Cards ───────────────────────────────────────────────────────────────────

router.get("/cards", async (req, res) => {
  try {
    if (!(await hasPermission(req, "view"))) {
      return res.status(403).json({ error: "forbidden" });
    }
    const db = getWebFirestore();
    const items = await listCards(db);
    res.status(200).json(items);
  } catch (err) {
    handleServiceError(err, res);
  }
});

router.post("/cards", async (req, res) => {
  try {
    if (!(await hasPermission(req, "create"))) {
      return res.status(403).json({ error: "forbidden" });
    }
    const db = getWebFirestore();
    const result = await createCard(db, req.body);
    res.status(201).json(result);
  } catch (err) {
    handleServiceError(err, res);
  }
});

router.put("/cards/:id", async (req, res) => {
  try {
    if (!(await hasPermission(req, "edit"))) {
      return res.status(403).json({ error: "forbidden" });
    }
    const db = getWebFirestore();
    await updateCard(db, req.params.id, req.body);
    res.status(200).json({ ok: true });
  } catch (err) {
    handleServiceError(err, res);
  }
});

router.delete("/cards/:id", async (req, res) => {
  try {
    if (!(await hasPermission(req, "delete"))) {
      return res.status(403).json({ error: "forbidden" });
    }
    const db = getWebFirestore();
    await deleteCard(db, req.params.id);
    res.status(200).json({ ok: true });
  } catch (err) {
    handleServiceError(err, res);
  }
});

// ─── Charts ──────────────────────────────────────────────────────────────────

router.get("/charts", async (req, res) => {
  try {
    if (!(await hasPermission(req, "view"))) {
      return res.status(403).json({ error: "forbidden" });
    }
    const db = getWebFirestore();
    const items = await listCharts(db);
    res.status(200).json(items);
  } catch (err) {
    handleServiceError(err, res);
  }
});

router.post("/charts", async (req, res) => {
  try {
    if (!(await hasPermission(req, "create"))) {
      return res.status(403).json({ error: "forbidden" });
    }
    const db = getWebFirestore();
    const result = await createChart(db, req.body);
    res.status(201).json(result);
  } catch (err) {
    handleServiceError(err, res);
  }
});

router.put("/charts/:id", async (req, res) => {
  try {
    if (!(await hasPermission(req, "edit"))) {
      return res.status(403).json({ error: "forbidden" });
    }
    const db = getWebFirestore();
    await updateChart(db, req.params.id, req.body);
    res.status(200).json({ ok: true });
  } catch (err) {
    handleServiceError(err, res);
  }
});

router.delete("/charts/:id", async (req, res) => {
  try {
    if (!(await hasPermission(req, "delete"))) {
      return res.status(403).json({ error: "forbidden" });
    }
    const db = getWebFirestore();
    await deleteChart(db, req.params.id);
    res.status(200).json({ ok: true });
  } catch (err) {
    handleServiceError(err, res);
  }
});

// ─── Admin Dashboard Overrides ───────────────────────────────────────────────

router.get("/overrides", async (req, res) => {
  try {
    if (!(await hasPermission(req, "view"))) {
      return res.status(403).json({ error: "forbidden" });
    }
    const accountId = String((req as any).admin?.accountId ?? "").trim();
    if (!accountId) return res.status(400).json({ error: "accountId_required" });

    const db = getWebFirestore();

    // Get cards and charts filtered by target=admin|both
    const [mergedCards, mergedCharts] = await Promise.all([
      listMergedCards(db),
      listMergedCharts(db),
    ]);

    const { filterByTarget } = await import("./dashboard-filters.js");
    const cards = filterByTarget(
      mergedCards.map((m) => ({ ...m.data, source: m.source, readonly: m.readonly })),
      "admin"
    );
    const charts = filterByTarget(
      mergedCharts.map((m) => ({ ...m.data, source: m.source, readonly: m.readonly })),
      "admin"
    );

    // Read existing account-level overrides
    const overrideSnap = await db.collection("admin-dashboard-overrides").doc(accountId).get();
    const overrides = overrideSnap.exists ? (overrideSnap.data()?.entries ?? null) : null;

    return res.status(200).json({ cards, charts, overrides });
  } catch (err) {
    handleServiceError(err, res);
  }
});

router.put("/overrides", async (req, res) => {
  try {
    if (!(await hasPermission(req, "edit"))) {
      return res.status(403).json({ error: "forbidden" });
    }
    const accountId = String((req as any).admin?.accountId ?? "").trim();
    if (!accountId) return res.status(400).json({ error: "accountId_required" });

    const entries = req.body?.entries;
    if (!Array.isArray(entries)) {
      return res.status(400).json({ error: "entries_required" });
    }

    const db = getWebFirestore();
    const { FieldValue } = await import("firebase-admin/firestore");
    await db.collection("admin-dashboard-overrides").doc(accountId).set({
      entries,
      updatedAt: FieldValue.serverTimestamp(),
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    handleServiceError(err, res);
  }
});

export default router;
