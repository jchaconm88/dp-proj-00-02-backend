import { Router } from "express";
import { getWebFirestore } from "../../lib/firebase-admin.js";
import { listMergedCards, listMergedCharts, listMergedMetrics } from "./dashboard-catalog.service.js";
import { filterByTarget } from "./dashboard-filters.js";
import { createMetric, updateMetric, deleteMetric, createCard, updateCard, deleteCard, createChart, updateChart, deleteChart } from "./dashboard-config.service.js";
import { FieldValue } from "firebase-admin/firestore";

const router = Router();

// ─── GET /definitions ────────────────────────────────────────────────────────
// Lists all card and chart definitions with target=web|both,
// plus existing company overrides if any.
router.get("/definitions", async (req, res) => {
  try {
    const companyId = String(req.query?.companyId ?? "").trim();
    if (!companyId) {
      return res.status(400).json({ error: "companyId_required" });
    }

    const db = getWebFirestore();

    // Fetch merged cards & charts, then filter by target "web" (includes "both")
    const [mergedCards, mergedCharts] = await Promise.all([
      listMergedCards(db),
      listMergedCharts(db),
    ]);

    const cards = filterByTarget(
      mergedCards.map((m) => ({ ...m.data, source: m.source, readonly: m.readonly })),
      "web"
    );

    const charts = filterByTarget(
      mergedCharts.map((m) => ({ ...m.data, source: m.source, readonly: m.readonly })),
      "web"
    );

    // Read existing company overrides
    const overrideSnap = await db
      .collection("company-dashboard-overrides")
      .doc(companyId)
      .get();

    const overrides = overrideSnap.exists
      ? (overrideSnap.data()?.entries ?? null)
      : null;

    return res.status(200).json({ cards, charts, overrides });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/dashboard-config/definitions GET] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(500).json({ error: "internal", message: msg });
  }
});

// ─── PUT /overrides ──────────────────────────────────────────────────────────
// Saves company-level dashboard overrides.
router.put("/overrides", async (req, res) => {
  try {
    const companyId = String(req.body?.companyId ?? "").trim();
    if (!companyId) {
      return res.status(400).json({ error: "companyId_required" });
    }

    const entries = req.body?.entries;
    if (!Array.isArray(entries)) {
      return res.status(400).json({ error: "entries_required", message: "entries must be an array" });
    }

    // Validate each entry
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry || typeof entry !== "object") {
        return res.status(400).json({ error: "invalid_entry", message: `entries[${i}] must be an object` });
      }
      if (!entry.definitionId || typeof entry.definitionId !== "string") {
        return res.status(400).json({ error: "invalid_entry", message: `entries[${i}].definitionId is required` });
      }
      if (entry.definitionType !== "card" && entry.definitionType !== "chart") {
        return res.status(400).json({ error: "invalid_entry", message: `entries[${i}].definitionType must be "card" or "chart"` });
      }
      if (typeof entry.visible !== "boolean") {
        return res.status(400).json({ error: "invalid_entry", message: `entries[${i}].visible must be a boolean` });
      }
      if (!Number.isInteger(entry.order) || entry.order < 1) {
        return res.status(400).json({ error: "invalid_entry", message: `entries[${i}].order must be an integer >= 1` });
      }
    }

    const db = getWebFirestore();

    await db.collection("company-dashboard-overrides").doc(companyId).set({
      entries,
      updatedAt: FieldValue.serverTimestamp(),
    });

    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/dashboard-config/overrides PUT] failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return res.status(500).json({ error: "internal", message: msg });
  }
});

// ─── GET /metrics ────────────────────────────────────────────────────────────
// Lists all merged metric definitions filtered by target=web|both.
router.get("/metrics", async (req, res) => {
  try {
    const db = getWebFirestore();
    const items = await listMergedMetrics(db);
    // Filter to only web|both metrics
    const filtered = items.filter(
      (m) => {
        const t = (m.data as any).target;
        return t === "web" || t === "both";
      }
    );
    return res.status(200).json(filtered);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/dashboard-config/metrics GET] failed:", msg);
    return res.status(500).json({ error: "internal", message: msg });
  }
});

// ─── POST /metrics ───────────────────────────────────────────────────────────
// Creates a new metric definition (forces target to web|both only).
router.post("/metrics", async (req, res) => {
  try {
    const db = getWebFirestore();
    const payload = req.body;
    // Force target to "web" if not provided or if invalid for web context
    if (!payload.target || (payload.target !== "web" && payload.target !== "both")) {
      payload.target = "web";
    }
    const result = await createMetric(db, payload);
    return res.status(201).json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/dashboard-config/metrics POST] failed:", msg);
    if (msg.startsWith("Validation failed")) {
      return res.status(400).json({ error: "validation", message: msg });
    }
    return res.status(500).json({ error: "internal", message: msg });
  }
});

// ─── PUT /metrics/:id ────────────────────────────────────────────────────────
// Updates an existing metric definition (reject if readonly/default).
router.put("/metrics/:id", async (req, res) => {
  try {
    const db = getWebFirestore();
    await updateMetric(db, req.params.id, req.body);
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/dashboard-config/metrics PUT] failed:", msg);
    if (msg.includes("solo lectura") || msg.includes("not found")) {
      return res.status(400).json({ error: "bad_request", message: msg });
    }
    if (msg.startsWith("Validation failed")) {
      return res.status(400).json({ error: "validation", message: msg });
    }
    return res.status(500).json({ error: "internal", message: msg });
  }
});

// ─── DELETE /metrics/:id ─────────────────────────────────────────────────────
// Deletes a metric definition (reject if readonly/default, check references).
router.delete("/metrics/:id", async (req, res) => {
  try {
    const db = getWebFirestore();
    await deleteMetric(db, req.params.id);
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/dashboard-config/metrics DELETE] failed:", msg);
    if (msg.includes("solo lectura") || msg.includes("not found") || msg.includes("referenciada")) {
      return res.status(400).json({ error: "bad_request", message: msg });
    }
    return res.status(500).json({ error: "internal", message: msg });
  }
});

// ─── POST /cards ─────────────────────────────────────────────────────────────
// Creates a new card definition (forces target to web|both).
router.post("/cards", async (req, res) => {
  try {
    const db = getWebFirestore();
    const payload = req.body;
    // Force target to "web" if not provided or if invalid for web context
    if (!payload.target || (payload.target !== "web" && payload.target !== "both")) {
      payload.target = "web";
    }
    const result = await createCard(db, payload);
    return res.status(201).json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/dashboard-config/cards POST] failed:", msg);
    if (msg.startsWith("Validation failed")) {
      return res.status(400).json({ error: "validation", message: msg });
    }
    return res.status(500).json({ error: "internal", message: msg });
  }
});

// ─── PUT /cards/:id ──────────────────────────────────────────────────────────
// Updates an existing card definition (reject if readonly/default).
router.put("/cards/:id", async (req, res) => {
  try {
    const db = getWebFirestore();
    await updateCard(db, req.params.id, req.body);
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/dashboard-config/cards PUT] failed:", msg);
    if (msg.includes("solo lectura") || msg.includes("not found")) {
      return res.status(400).json({ error: "bad_request", message: msg });
    }
    if (msg.startsWith("Validation failed")) {
      return res.status(400).json({ error: "validation", message: msg });
    }
    return res.status(500).json({ error: "internal", message: msg });
  }
});

// ─── DELETE /cards/:id ───────────────────────────────────────────────────────
// Deletes a card definition (reject if readonly/default).
router.delete("/cards/:id", async (req, res) => {
  try {
    const db = getWebFirestore();
    await deleteCard(db, req.params.id);
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/dashboard-config/cards DELETE] failed:", msg);
    if (msg.includes("solo lectura") || msg.includes("not found")) {
      return res.status(400).json({ error: "bad_request", message: msg });
    }
    return res.status(500).json({ error: "internal", message: msg });
  }
});

// ─── POST /charts ────────────────────────────────────────────────────────────
// Creates a new chart definition (forces target to web|both).
router.post("/charts", async (req, res) => {
  try {
    const db = getWebFirestore();
    const payload = req.body;
    // Force target to "web" if not provided or if invalid for web context
    if (!payload.target || (payload.target !== "web" && payload.target !== "both")) {
      payload.target = "web";
    }
    const result = await createChart(db, payload);
    return res.status(201).json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/dashboard-config/charts POST] failed:", msg);
    if (msg.startsWith("Validation failed")) {
      return res.status(400).json({ error: "validation", message: msg });
    }
    return res.status(500).json({ error: "internal", message: msg });
  }
});

// ─── PUT /charts/:id ─────────────────────────────────────────────────────────
// Updates an existing chart definition (reject if readonly/default).
router.put("/charts/:id", async (req, res) => {
  try {
    const db = getWebFirestore();
    await updateChart(db, req.params.id, req.body);
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/dashboard-config/charts PUT] failed:", msg);
    if (msg.includes("solo lectura") || msg.includes("not found")) {
      return res.status(400).json({ error: "bad_request", message: msg });
    }
    if (msg.startsWith("Validation failed")) {
      return res.status(400).json({ error: "validation", message: msg });
    }
    return res.status(500).json({ error: "internal", message: msg });
  }
});

// ─── DELETE /charts/:id ──────────────────────────────────────────────────────
// Deletes a chart definition (reject if readonly/default).
router.delete("/charts/:id", async (req, res) => {
  try {
    const db = getWebFirestore();
    await deleteChart(db, req.params.id);
    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[web/dashboard-config/charts DELETE] failed:", msg);
    if (msg.includes("solo lectura") || msg.includes("not found")) {
      return res.status(400).json({ error: "bad_request", message: msg });
    }
    return res.status(500).json({ error: "internal", message: msg });
  }
});

export default router;
