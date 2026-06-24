import type { Request } from "express";
import { Router } from "express";
import { ZodError } from "zod";
import {
  assertValidConnectionName,
  getDatabasesConfigNormalized,
  writeDatabasesFileConfig,
} from "../config/databases";

export const adminApiRouter = Router();

/** URL MCP publique : `URL_PUBLIC` + `/mcp` + query ; `token` pour Claude / ChatGPT. */
function buildMcpUrlFromEnv(req: Request, type: string, name: string): {
  url: string;
  usedFallbackBase: boolean;
} {
  const apiKey = process.env.API_KEY?.trim();
  if (!apiKey) {
    throw new Error("API_KEY manquant dans l’environnement.");
  }

  const publicRaw = process.env.URL_PUBLIC?.trim();
  let u: URL;
  let usedFallbackBase = false;

  if (publicRaw) {
    const normalized = /^https?:\/\//i.test(publicRaw) ? publicRaw : `https://${publicRaw}`;
    let base: URL;
    try {
      base = new URL(normalized);
    } catch {
      throw new Error("URL_PUBLIC invalide (URL mal formée).");
    }
    const p = base.pathname.replace(/\/$/, "");
    if (!p || p === "/") {
      u = new URL("/mcp", base.origin);
    } else {
      u = new URL(`${p}/mcp`, base.origin);
    }
  } else {
    usedFallbackBase = true;
    const proto = (req.get("x-forwarded-proto") || req.protocol)
      .split(",")[0]
      .trim();
    const host = (req.get("x-forwarded-host") || req.get("host") || "localhost")
      .split(",")[0]
      .trim();
    u = new URL(`${proto}://${host}/mcp`);
  }

  u.searchParams.set("type", type);
  u.searchParams.set("name", name);
  u.searchParams.set("token", apiKey);
  return { url: u.toString(), usedFallbackBase };
}

adminApiRouter.get("/mcp-url", (req, res) => {
  const type = String(req.query.type ?? "")
    .toLowerCase()
    .trim();
  const name = String(req.query.name ?? "").trim();

  if (type !== "odbc" && type !== "mysql" && type !== "mssql") {
    return res.status(400).json({
      error: "Paramètre type requis : odbc, mysql ou mssql.",
    });
  }
  try {
    assertValidConnectionName(name);
  } catch (e) {
    return res.status(400).json({
      error: e instanceof Error ? e.message : String(e),
    });
  }

  try {
    const { url, usedFallbackBase } = buildMcpUrlFromEnv(req, type, name);
    res.json({
      url,
      usedFallbackBase,
      auth: {
        urlParam: "token",
        header: "x-api-key",
        hint:
          "Claude / ChatGPT : collez l’URL complète (token inclus). Autres clients : préférez l’en-tête x-api-key sans token dans l’URL.",
      },
    });
  } catch (e) {
    res.status(500).json({
      error: e instanceof Error ? e.message : String(e),
    });
  }
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

  if (type !== "odbc" && type !== "mysql" && type !== "mssql") {
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
    const key = type as "odbc" | "mysql" | "mssql";
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
