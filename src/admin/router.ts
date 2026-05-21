import { Router } from "express";
import { ZodError } from "zod";
import {
  assertValidConnectionName,
  getDatabasesConfigNormalized,
  writeDatabasesFileConfig,
} from "../config/databases";

export const adminApiRouter = Router();

adminApiRouter.use((_req, res, next) => {
  if (!process.env.API_KEY?.trim()) {
    return res.status(503).json({
      error:
        "Définissez API_KEY dans .env pour activer l’interface d’administration.",
    });
  }
  next();
});

adminApiRouter.get("/config", (_req, res) => {
  try {
    res.json(getDatabasesConfigNormalized());
  } catch (e) {
    res.status(500).json({
      error: e instanceof Error ? e.message : String(e),
    });
  }
});

adminApiRouter.put("/config", (req, res) => {
  try {
    writeDatabasesFileConfig(req.body);
    res.json({ ok: true, config: getDatabasesConfigNormalized() });
  } catch (e) {
    if (e instanceof ZodError) {
      return res.status(400).json({
        error: "Configuration invalide (schéma Zod)",
        details: e.flatten(),
      });
    }
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

adminApiRouter.delete("/connection/:type/:name", (req, res) => {
  const { type, name: rawName } = req.params;
  const name = decodeURIComponent(rawName);

  if (type !== "hfsql" && type !== "mysql" && type !== "mssql") {
    return res.status(400).json({ error: "Type invalide" });
  }
  try {
    assertValidConnectionName(name);
  } catch (e) {
    return res.status(400).json({
      error: e instanceof Error ? e.message : String(e),
    });
  }

  try {
    const next = getDatabasesConfigNormalized();
    const key = type as "hfsql" | "mysql" | "mssql";
    if (!next.databases[key][name]) {
      return res.status(404).json({ error: "Connexion introuvable" });
    }
    delete next.databases[key][name];

    const defs = { ...next.defaults } as Record<string, string | undefined>;
    if (defs[key] === name) {
      delete defs[key];
    }
    next.defaults = defs;

    writeDatabasesFileConfig(next);
    res.json({ ok: true, config: getDatabasesConfigNormalized() });
  } catch (e) {
    if (e instanceof ZodError) {
      return res.status(400).json({
        error: "Configuration invalide après suppression",
        details: e.flatten(),
      });
    }
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});
