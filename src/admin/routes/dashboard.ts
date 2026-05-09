import { Router } from "express";
import { getWebFirestore } from "../../lib/firebase-admin.js";

const router = Router();

router.get("/snapshot", async (req, res) => {
  const accountId = String(req.query.accountId ?? "").trim();
  const period = String(req.query.period ?? "").trim();
  if (!accountId) return res.status(400).json({ error: "accountId_required" });
  if (!/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({ error: "period_invalid" });
  const id = `${accountId}_${period}`;
  const snap = await getWebFirestore().collection("dashboard-snapshots").doc(id).get();
  // Para Admin, si aún no existe snapshot (p.ej. cuentas nuevas), devolvemos un snapshot vacío.
  if (!snap.exists) {
    return res.status(200).json({
      period,
      cards: [],
      activityReports: [],
      activityTrips: [],
      hasUsageForPeriod: false,
    });
  }
  const data = snap.data() ?? {};
  res.status(200).json({
    period: String((data as any).period ?? period),
    cards: Array.isArray((data as any).cards) ? (data as any).cards : [],
    activityReports: Array.isArray((data as any).activityReports) ? (data as any).activityReports : [],
    activityTrips: Array.isArray((data as any).activityTrips) ? (data as any).activityTrips : [],
    hasUsageForPeriod: Boolean(
      (data as any).usage &&
        typeof (data as any).usage === "object" &&
        Object.keys((data as any).usage).length > 0
    ),
  });
});

router.post("/prepare-snapshot", async (_req, res) => {
  // En transición: el snapshot se sigue generando por Functions. Este endpoint queda para on-demand más adelante.
  res.status(200).json({ ok: true });
});

export default router;

