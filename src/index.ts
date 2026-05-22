import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import express from "express";
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

const PORT = process.env.PORT || 3333;
const API_KEY = process.env.API_KEY;
const ALLOWED_IPS: string[] = process.env.ALLOWED_IPS
  ? process.env.ALLOWED_IPS.split(",").map((ip) => ip.trim())
  : [];

function backendLabel(type: BackendType): string {
  switch (type) {
    case "hfsql":
      return "HFSQL (ODBC)";
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
    `Exécute une requête SELECT uniquement (${label})`,
    { sql: z.string(), limit: z.number().optional().default(100) },
    async ({ sql, limit }) => {
      if (!/^\s*SELECT/i.test(sql.trim())) {
        return { content: [{ type: "text", text: "❌ SELECT uniquement." }] };
      }
      const rows = await backend.runSelect(sql, limit);
      return {
        content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
      };
    }
  );

  return server;
}

const app = express();

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
  if (!API_KEY) return next();

  const keyFromHeader = req.headers["x-api-key"];
  const keyFromQuery = req.query.token;

  if (keyFromHeader === API_KEY || keyFromQuery === API_KEY) {
    return next();
  }

  res.status(401).json({ error: "Non autorisé" });
});

app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
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
  if (!API_KEY?.trim()) {
    return res
      .status(503)
      .type("html")
      .send(
        "<!DOCTYPE html><html lang=fr><head><meta charset=utf-8><title>Admin</title></head><body>" +
          "<p>Définissez <code>API_KEY</code> dans <code>.env</code> pour accéder à l’interface de gestion des connexions.</p>" +
          "</body></html>"
      );
  }
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

app.use("/admin/api", express.json({ limit: "512kb" }), adminApiRouter);

app.all("/mcp", express.json(), async (req, res) => {
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
    JSON.stringify(req.body)
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
    `✅ MCP SQL sur http://localhost:${PORT} — /mcp?type=… et admin http://localhost:${PORT}/admin?token=…`
  );
});
