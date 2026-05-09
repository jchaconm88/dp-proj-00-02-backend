import { Router } from "express";
import { getAdminModules, getAdminModuleById, type ModuleRecord as AdminModuleRecord } from "../../../data/admin-modules.js";
import { getWebModules, getWebModuleById, type ModuleRecord as WebModuleRecord } from "../../../data/web-modules.js";

const router = Router();

// ─── Admin Modules (catálogo de módulos del panel admin) ─────────────────────

router.get("/admin-modules", (_req, res) => {
  try {
    const items: AdminModuleRecord[] = getAdminModules();
    res.status(200).json(items);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/admin-modules GET] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

router.get("/admin-modules/:id", (req, res) => {
  try {
    const mod = getAdminModuleById(req.params.id);
    if (!mod) return res.status(404).json({ error: "not_found" });
    res.status(200).json(mod);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/admin-modules/:id GET] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

// ─── Web Modules (catálogo de módulos de la app web) ─────────────────────────

router.get("/web-modules", (_req, res) => {
  try {
    const items: WebModuleRecord[] = getWebModules();
    res.status(200).json(items);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/web-modules GET] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

router.get("/web-modules/:id", (req, res) => {
  try {
    const mod = getWebModuleById(req.params.id);
    if (!mod) return res.status(404).json({ error: "not_found" });
    res.status(200).json(mod);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/web-modules/:id GET] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

export default router;

