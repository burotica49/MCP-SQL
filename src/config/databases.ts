import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const connectionNameRegex = /^[a-zA-Z0-9_-]+$/;

const odbcEntrySchema = z.object({
  dsn: z.string().min(1),
});

const mysqlEntrySchema = z.object({
  host: z.string().min(1),
  port: z.number().int().positive().optional(),
  user: z.string().min(1),
  password: z.string().optional().default(""),
  database: z.string().min(1),
});

const mssqlEntrySchema = z.object({
  server: z.string().min(1),
  port: z.number().int().positive().optional(),
  user: z.string().min(1),
  password: z.string().optional().default(""),
  database: z.string().min(1),
  encrypt: z.boolean().optional(),
  trustServerCertificate: z.boolean().optional(),
});

export const databasesFileSchema = z.object({
  defaults: z
    .object({
      odbc: z.string().optional(),
      mysql: z.string().optional(),
      mssql: z.string().optional(),
    })
    .optional(),
  databases: z
    .object({
      odbc: z.record(z.string(), odbcEntrySchema).optional(),
      mysql: z.record(z.string(), mysqlEntrySchema).optional(),
      mssql: z.record(z.string(), mssqlEntrySchema).optional(),
    })
    .optional(),
});

export type DatabasesFileConfig = z.infer<typeof databasesFileSchema>;
export type MysqlEntryConfig = z.infer<typeof mysqlEntrySchema>;
export type MssqlEntryConfig = z.infer<typeof mssqlEntrySchema>;

let cache: { resolvedPath: string; config: DatabasesFileConfig | null } | null =
  null;

function emptyNormalized(): DatabasesFileConfig {
  return {
    defaults: {},
    databases: { odbc: {}, mysql: {}, mssql: {} },
  };
}

/** Chemin absolu du fichier JSON (défaut : `databases.json` à la racine du projet). */
export function getDatabasesFilePath(): string {
  const fromEnv = process.env.MCP_DATABASES_FILE?.trim();
  if (fromEnv) {
    return path.isAbsolute(fromEnv)
      ? fromEnv
      : path.resolve(process.cwd(), fromEnv);
  }
  return path.join(process.cwd(), "databases.json");
}

/**
 * Lit et valide `databases.json`. Résultat mis en cache jusqu’au redémarrage du processus.
 * Si le fichier est absent : retourne `null` (repli sur le `.env`).
 */
export function loadDatabasesFileConfig(): DatabasesFileConfig | null {
  const resolvedPath = getDatabasesFilePath();
  if (cache && cache.resolvedPath === resolvedPath) {
    return cache.config;
  }

  if (!fs.existsSync(resolvedPath)) {
    cache = { resolvedPath, config: null };
    return null;
  }

  const raw = fs.readFileSync(resolvedPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (e) {
    throw new Error(
      `databases.json : JSON invalide (${resolvedPath}) — ${e instanceof Error ? e.message : e}`
    );
  }

  const config = databasesFileSchema.parse(parsed);
  cache = { resolvedPath, config };
  return config;
}

/** Fusionne la config chargée avec une structure exploitable par l’UI (enregistrements vides explicites). */
export function getDatabasesConfigNormalized(): DatabasesFileConfig {
  const cfg = loadDatabasesFileConfig();
  const base = emptyNormalized();
  if (!cfg) return base;
  return {
    defaults: { ...base.defaults, ...cfg.defaults },
    databases: {
      odbc: { ...base.databases!.odbc, ...cfg.databases?.odbc },
      mysql: { ...base.databases!.mysql, ...cfg.databases?.mysql },
      mssql: { ...base.databases!.mssql, ...cfg.databases?.mssql },
    },
  };
}

export function assertValidConnectionName(name: string): void {
  if (!connectionNameRegex.test(name)) {
    throw new Error(
      "Paramètre name invalide (lettres, chiffres, tiret - et _ uniquement)."
    );
  }
}

/** Après modification du fichier sur disque, force une relecture au prochain chargement. */
export function invalidateDatabasesConfigCache(): void {
  cache = null;
}

/**
 * Valide et écrit `databases.json` (crée le fichier et les répertoires parents si besoin).
 * Met à jour le cache en mémoire.
 */
export function writeDatabasesFileConfig(config: unknown): DatabasesFileConfig {
  const parsed = databasesFileSchema.parse(config);
  const filePath = getDatabasesFilePath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const json = `${JSON.stringify(parsed, null, 2)}\n`;
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, json, "utf8");
  try {
    fs.renameSync(tmp, filePath);
  } catch {
    fs.copyFileSync(tmp, filePath);
    fs.unlinkSync(tmp);
  }
  invalidateDatabasesConfigCache();
  cache = { resolvedPath: filePath, config: parsed };
  return parsed;
}
