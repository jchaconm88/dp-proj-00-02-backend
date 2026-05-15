import { Router } from "express";
import { getWebFirestore } from "../../../lib/firebase-admin.js";
import {
  getCountryByCode,
  filterAllowedCurrenciesByCountry,
  type CountryCode,
} from "../../../data/countries.js";
import { parseCurrencyCode, type CurrencyCode } from "../../../data/currencies.js";

function requireAccountId(req: any): string {
  const accountId = String(req?.admin?.accountId ?? "").trim();
  if (!accountId) throw new Error("missing_accountId");
  return accountId;
}

async function checkTaxIdUnique(taxId: string, excludeId?: string): Promise<boolean> {
  const db = getWebFirestore();
  const snap = await db.collection("companies").where("taxId", "==", taxId.trim()).limit(2).get();
  if (snap.empty) return true;
  if (excludeId) {
    return snap.docs.every((doc) => doc.id === excludeId);
  }
  return false;
}

const router = Router();

function normalizeCompanyCurrencyConfig(body: Record<string, unknown>): {
  countryCode: CountryCode;
  allowedCurrencies: CurrencyCode[];
  defaultCurrency: CurrencyCode;
} {
  const countryCodeRaw = String(body.countryCode ?? "").trim().toUpperCase();
  const country = getCountryByCode(countryCodeRaw);
  if (!country) {
    throw new Error("countryCode_invalid");
  }

  const allowedCurrencies = filterAllowedCurrenciesByCountry(country.code, body.allowedCurrencies);
  if (!allowedCurrencies || allowedCurrencies.length === 0) {
    throw new Error("allowedCurrencies_required");
  }

  const defaultCurrency = parseCurrencyCode(body.defaultCurrency);
  if (!defaultCurrency || !allowedCurrencies.includes(defaultCurrency)) {
    throw new Error("defaultCurrency_invalid");
  }

  return { countryCode: country.code, allowedCurrencies, defaultCurrency };
}

router.get("/", async (_req, res) => {
  try {
    const req = _req as any;
    const accountId = requireAccountId(req);
    const db = getWebFirestore();
    const snap = await db.collection("companies").where("accountId", "==", accountId).get();
    const items = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.status(200).json(items);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/companies GET] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

router.get("/check-taxid", async (_req, res) => {
  try {
    const req = _req as any;
    requireAccountId(req);
    const taxId = String(req.query.taxId ?? "").trim();
    if (!taxId) return res.status(400).json({ error: "taxId_required" });
    const unique = await checkTaxIdUnique(taxId);
    res.status(200).json({ ok: true, unique });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/companies check-taxid GET] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const snap = await db.collection("companies").doc(id).get();
    if (!snap.exists) return res.status(404).json({ error: "not_found" });
    if (String(snap.data()?.accountId ?? "") !== accountId) {
      return res.status(403).json({ error: "forbidden" });
    }
    res.status(200).json({ id: snap.id, ...snap.data() });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/companies GET by id] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

router.post("/", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const db = getWebFirestore();
    const now = new Date();
    const body = req.body ?? {};
    const name = body.name;
    const status = body.status ?? "active";
    const taxId = body.taxId;
    const finalCode = String(body.code ?? "").trim();
    const currencyConfig = normalizeCompanyCurrencyConfig(body);
    
    if (!name) return res.status(400).json({ error: "name_required" });
    if (!finalCode) return res.status(400).json({ error: "code_required" });
    if (finalCode.includes("/") || finalCode.includes("\0")) {
      return res.status(400).json({ error: "invalid_code", message: "El código no puede contener '/' ni caracteres inválidos" });
    }
    
    if (taxId) {
      const unique = await checkTaxIdUnique(String(taxId));
      if (!unique) {
        return res.status(409).json({ error: "taxid_duplicate", message: "Ya existe una empresa con ese RUC" });
      }
    }
    
    const codeDup = await db
      .collection("companies")
      .where("accountId", "==", accountId)
      .where("code", "==", finalCode)
      .limit(1)
      .get();
    if (!codeDup.empty) {
      return res.status(409).json({ error: "code_duplicate", message: "Ya existe una empresa con ese código" });
    }
    
    const docRef = await db.collection("companies").add({
      name: String(name).trim(),
      status: String(status),
      accountId,
      code: finalCode,
      countryCode: currencyConfig.countryCode,
      allowedCurrencies: currencyConfig.allowedCurrencies,
      defaultCurrency: currencyConfig.defaultCurrency,
      ...(taxId !== undefined && taxId !== null && String(taxId).trim() !== "" ? { taxId: String(taxId).trim() } : {}),
      createdAt: now,
      updatedAt: now,
    });
    const created = {
      id: docRef.id,
      name: String(name).trim(),
      status: String(status),
      accountId,
      code: finalCode,
      countryCode: currencyConfig.countryCode,
      allowedCurrencies: currencyConfig.allowedCurrencies,
      defaultCurrency: currencyConfig.defaultCurrency,
      ...(taxId !== undefined && taxId !== null && String(taxId).trim() !== "" ? { taxId: String(taxId).trim() } : {}),
    };
    res.status(201).json(created);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/companies POST] failed:", msg);
    if (msg === "countryCode_invalid" || msg === "allowedCurrencies_required" || msg === "defaultCurrency_invalid") {
      return res.status(422).json({ error: msg });
    }
    res.status(500).json({ error: "internal", message: msg });
  }
});

router.put("/:id", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const { id: _id, createdAt: _ca, taxId, ...fields } = req.body ?? {};
    const existing = await db.collection("companies").doc(id).get();
    if (!existing.exists || String(existing.data()?.accountId ?? "") !== accountId) {
      return res.status(403).json({ error: "forbidden" });
    }
    
    if (taxId !== undefined) {
      const unique = await checkTaxIdUnique(String(taxId), id);
      if (!unique) {
        return res.status(409).json({ error: "taxid_duplicate", message: "Ya existe una empresa con ese RUC" });
      }
      fields.taxId = String(taxId).trim();
    }

    if (req.body?.countryCode !== undefined || req.body?.allowedCurrencies !== undefined || req.body?.defaultCurrency !== undefined) {
      const currencyConfig = normalizeCompanyCurrencyConfig(req.body ?? {});
      fields.countryCode = currencyConfig.countryCode;
      fields.allowedCurrencies = currencyConfig.allowedCurrencies;
      fields.defaultCurrency = currencyConfig.defaultCurrency;
    }
    
    await db.collection("companies").doc(id).update({
      ...fields,
      updatedAt: new Date(),
    });
    res.status(200).json({ ok: true, id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/companies PUT] failed:", msg);
    if (msg === "countryCode_invalid" || msg === "allowedCurrencies_required" || msg === "defaultCurrency_invalid") {
      return res.status(422).json({ error: msg });
    }
    res.status(500).json({ error: "internal", message: msg });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const db = getWebFirestore();
    const { id } = req.params;
    const existing = await db.collection("companies").doc(id).get();
    if (!existing.exists || String(existing.data()?.accountId ?? "") !== accountId) {
      return res.status(403).json({ error: "forbidden" });
    }
    await db.collection("companies").doc(id).delete();
    res.status(200).json({ ok: true, id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/platform/companies DELETE] failed:", msg);
    res.status(500).json({ error: "internal", message: msg });
  }
});

export default router;
