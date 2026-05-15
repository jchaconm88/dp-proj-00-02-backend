import { Router } from "express";
import { getUbigeosByCountry, parseUbigeoCountry } from "../../../data/ubigeos.js";

const router = Router();

router.get("/ubigeos", async (req, res) => {
  try {
    const country = parseUbigeoCountry(req.query.country ?? "PE");
    if (!country) {
      return res.status(400).json({ error: "country_required", message: "Debe enviar country válido (ej. PE)." });
    }
    const items = getUbigeosByCountry(country).map((row) => ({
      code: row.code,
      name: row.name,
      country: row.country,
    }));
    return res.status(200).json({ items });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/ubigeos GET] failed:", msg);
    return res.status(500).json({ error: "internal", message: msg });
  }
});

export default router;
