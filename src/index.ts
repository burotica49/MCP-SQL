import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import ipRangeCheck from "ip-range-check";
import type { BackendType, DatabaseBackend } from "./backends/types";
import {
  parseBackendType,
  parseConnectionName,
  resolveBackend,
  validateDatabaseName,
} from "./backends/factory";
import { adminApiRouter } from "./admin/router";
import { getDatabasesFilePath, loadDatabasesFileConfig } from "./config/databases";
import { applySqlServerTop } from "./backends/sqlserver-top";
import { assertReadOnlySelect } from "./backends/sql-readonly-guard";

const PORT = process.env.PORT || 3333;
const API_KEY = process.env.API_KEY?.trim();
if (!API_KEY) {
  console.error("❌ API_KEY obligatoire : définissez-le dans .env");
  process.exit(1);
}
const IS_DEV = process.env.NODE_ENV !== "production";
/** Claude / ChatGPT MCP : pas d’en-têtes custom → jeton dans l’URL (`?token=`). Désactiver : `ALLOW_URL_TOKEN=false`. */
const ALLOW_URL_TOKEN = process.env.ALLOW_URL_TOKEN !== "false";
const ALLOWED_IPS: string[] = process.env.ALLOWED_IPS
  ? process.env.ALLOWED_IPS.split(",").map((ip) => ip.trim())
  : [];

function backendLabel(type: BackendType): string {
  switch (type) {
    case "odbc":
      return "ODBC";
    case "mysql":
      return "MySQL";
    case "mssql":
      return "Microsoft SQL Server";
    default: {
      const _e: never = type;
      return _e;
    }
  }
}

/** Texte visible par le modèle dans le catalogue d’outils MCP : dialecte SQL attendu. */
function queryToolDescription(type: BackendType): string {
  const label = backendLabel(type);
  const intro = `Exécute une requête SELECT en lecture seule (${label}). Interdit : INSERT, UPDATE, DELETE, DDL, procédures stockées hors simple SELECT.`;

  switch (type) {
    case "mysql":
      return (
        `${intro} Dialecte MySQL : LIMIT autorisé dans le SQL ; sinon le serveur peut ajouter LIMIT selon le paramètre limit.`
      );
    case "mssql":
      return (
        `${intro} Dialecte Transact-SQL : ne pas utiliser LIMIT ; borner avec le paramètre limit (TOP injecté côté serveur). ` +
        `Exemple : SELECT * FROM dbo.MaTable ORDER BY Date DESC avec limit=1.`
      );
    case "odbc":
      return (
        `${intro} Plafond style T-SQL (TOP) : ne pas mettre LIMIT dans le SQL ; utiliser le paramètre limit. ` +
        `Exemple : SELECT * FROM MaTable ORDER BY Date DESC avec limit=1.`
      );
    default: {
      const _e: never = type;
      return _e;
    }
  }
}

function buildServer(backend: DatabaseBackend, type: BackendType) {
  const label = backendLabel(type);
  const server = new McpServer({
    name: "sql-mcp-server",
    version: "1.3.0",
  });

  server.tool(
    "list_tables",
    `Liste toutes les tables (${label})`,
    {},
    async () => {
      const tables = await backend.listTables();
      return {
        content: [
          { type: "text", text: JSON.stringify(tables, null, 2) },
        ],
      };
    }
  );

  server.tool(
    "describe_table",
    `Décrit les colonnes d'une table (${label})`,
    { table: z.string() },
    async ({ table }) => {
      const cols = await backend.describeTable(table);
      return {
        content: [{ type: "text", text: JSON.stringify(cols, null, 2) }],
      };
    }
  );

  server.tool(
    "query",
    queryToolDescription(type),
    {
      sql: z
        .string()
        .describe(
          type === "mysql"
            ? "Requête SELECT (MySQL). LIMIT optionnel ; sinon utiliser limit."
            : type === "odbc"
              ? "Requête SELECT sans LIMIT (ODBC + TOP) : borner avec limit."
              : "Requête SELECT T-SQL sans LIMIT : borner avec limit."
        ),
      limit: z
        .number()
        .optional()
        .default(100)
        .describe("Nombre maximum de lignes renvoyées (TOP côté serveur pour MSSQL/ODBC)."),
    },
    async ({ sql, limit }) => {
      try {
        assertReadOnlySelect(sql);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: "text", text: `❌ ${msg}` }] };
      }
      const rows = await backend.runSelect(sql, limit);
      const text = JSON.stringify(
        rows,
        (_k, v) => (typeof v === "bigint" ? v.toString() : v),
        2
      );
      const content: { type: "text"; text: string }[] = [
        { type: "text", text },
      ];
      if (rows.length === 0 && (type === "odbc" || type === "mssql")) {
        const executed = applySqlServerTop(sql, limit);
        content.push({
          type: "text",
          text:
            `0 ligne : la requête s’est exécutée sans erreur mais le moteur n’a renvoyé aucun enregistrement.\n` +
            `SQL normalisé (TOP / retrait LIMIT) :\n${executed}\n` +
            `À vérifier : bonne base / DSN, schéma (ex. dbo.ENTFACTURE), table réellement peuplée, filtres implicites, ` +
            `et identifiants entre crochets si mot réservé (ex. ORDER BY [DATE]).`,
        });
      }
      return { content };
    }
  );

  return server;
}

function redactUrl(url: string): string {
  return url.replace(/([?&]token=)[^&]+/gi, "$1***");
}

function isApiKeyValid(req: express.Request): boolean {
  if (req.headers["x-api-key"] === API_KEY) return true;
  if (ALLOW_URL_TOKEN && req.path === "/mcp") {
    const fromQuery = req.query.token;
    if (typeof fromQuery === "string" && fromQuery === API_KEY) return true;
  }
  return false;
}

const app = express();

app.set("trust proxy", 1);

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "script-src": ["'self'", "'unsafe-inline'"],
        "style-src": ["'self'", "'unsafe-inline'"],
      },
    },
  })
);

const apiLimiter = rateLimit({
  windowMs: 60_000,
  max: parseInt(process.env.RATE_LIMIT_MAX ?? "120", 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Trop de requêtes, réessayez plus tard." },
});

function isPublicRoute(req: express.Request): boolean {
  if (req.path === "/health") return true;
  if (req.path === "/admin" && req.method === "GET") return true;
  if (req.path.startsWith("/.well-known/")) return true;
  return false;
}

app.use((req, res, next) => {
  if (ALLOWED_IPS.length === 0) return next();

  const clientIp =
    (req.headers["cf-connecting-ip"] as string) || req.ip || "";

  if (ipRangeCheck(clientIp, ALLOWED_IPS)) {
    return next();
  }

  console.warn(`[BLOCKED] IP refusée: ${clientIp} — ${req.method} ${req.url}`);
  res.status(403).json({ error: "Forbidden" });
});

app.use((req, res, next) => {
  if (isPublicRoute(req)) return next();

  if (isApiKeyValid(req)) {
    return next();
  }

  res.status(401).json({ error: "Non autorisé" });
});

app.use((req, _res, next) => {
  console.log(
    `[${new Date().toISOString()}] ${req.method} ${redactUrl(req.originalUrl)}`
  );
  next();
});

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.get("/.well-known/oauth-authorization-server", (_req, res) =>
  res.status(404).json({})
);
app.get("/.well-known/openid-configuration", (_req, res) =>
  res.status(404).json({})
);

app.get("/admin", (_req, res) => {
  const htmlPath = path.join(process.cwd(), "public", "admin.html");
  if (!fs.existsSync(htmlPath)) {
    return res
      .status(500)
      .type("html")
      .send(
        "<!DOCTYPE html><html lang=fr><head><meta charset=utf-8></head><body>" +
          "<p>Fichier <code>public/admin.html</code> introuvable.</p></body></html>"
      );
  }
  res.type("html").send(fs.readFileSync(htmlPath, "utf8"));
});

app.use("/admin/api", apiLimiter, express.json({ limit: "512kb" }), adminApiRouter);

app.all("/mcp", apiLimiter, express.json(), async (req, res) => {
  let backendType: BackendType;
  let database: string | undefined;
  let connectionName: string | undefined;
  try {
    backendType = parseBackendType(req.query.type);
    database = validateDatabaseName(req.query.database);
    connectionName = parseConnectionName(req.query.name);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(400).json({ error: msg });
    return;
  }

  let backend: DatabaseBackend;
  try {
    backend = await resolveBackend(backendType, {
      database,
      connectionName,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[mcp] backend:", msg);
    res.status(503).json({ error: msg });
    return;
  }

  console.log(
    "→ /mcp",
    req.method,
    `type=${backendType}`,
    connectionName ? `name=${connectionName}` : "",
    database ? `database=${database}` : "",
    IS_DEV ? JSON.stringify(req.body) : "(body omis en production)"
  );

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  const server = buildServer(backend, backendType);
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const stack = e instanceof Error ? e.stack : undefined;
    console.error("[mcp] transport / MCP:", msg, stack ? "\n" + stack : "");
    if (!res.headersSent) {
      res.status(500).json({ error: msg });
    }
  } finally {
    try {
      await server.close();
    } catch (closeErr) {
      console.error("[mcp] server.close:", closeErr);
    }
  }
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("[unhandledRejection]", reason, promise);
});

app.listen(PORT, () => {
  const cfgPath = getDatabasesFilePath();
  if (fs.existsSync(cfgPath)) {
    try {
      loadDatabasesFileConfig();
      console.log(`📄 Fichier BDD : ${cfgPath}`);
    } catch (e) {
      console.error("Impossible de charger databases.json :", e);
      process.exit(1);
    }
  }
  console.log(
    `✅ MCP SQL sur http://localhost:${PORT} — /mcp?token=…&type=… (Claude/ChatGPT) ou en-tête x-api-key`
  );
});
