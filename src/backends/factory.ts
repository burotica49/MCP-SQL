import {
  assertValidConnectionName,
  loadDatabasesFileConfig,
  type MssqlEntryConfig,
  type MysqlEntryConfig,
} from "../config/databases";
import type { BackendType, DatabaseBackend } from "./types";

/** Clé JSON insensible à la casse (ex. URL `name=flexigestion` ↔ entrée `Flexigestion`). */
function findEntryInSection<T extends Record<string, unknown>>(
  section: T | undefined,
  name: string
): { key: string; entry: T[string] } | undefined {
  if (!section || !name) return undefined;
  if (Object.prototype.hasOwnProperty.call(section, name)) {
    return { key: name, entry: section[name as keyof T] as T[string] };
  }
  const lower = name.toLowerCase();
  for (const key of Object.keys(section)) {
    if (key.toLowerCase() === lower) {
      return { key, entry: section[key as keyof T] as T[string] };
    }
  }
  return undefined;
}

/**
 * `type` dans l’URL : `hfsql` (défaut si absent), `mysql`, `mssql` (alias `sqlserver`).
 * Valeur inconnue → erreur explicite.
 */
export function parseBackendType(raw: unknown): BackendType {
  if (raw == null || String(raw).trim() === "") {
    return "hfsql";
  }
  const s = String(raw).toLowerCase().trim();
  if (s === "hfsql") return "hfsql";
  if (s === "mysql") return "mysql";
  if (s === "mssql" || s === "sqlserver") return "mssql";
  throw new Error(
    `Paramètre type invalide : «${s}». Utilisez hfsql, mysql ou mssql.`
  );
}

export function parseConnectionName(raw: unknown): string | undefined {
  if (raw == null || String(raw).trim() === "") return undefined;
  const name = String(raw).trim();
  assertValidConnectionName(name);
  return name;
}

/** Valide `database` passé en query string ; retourne undefined si absent. */
export function validateDatabaseName(raw: unknown): string | undefined {
  if (raw == null || raw === "") return undefined;
  const name = String(raw).trim();
  if (!/^[a-zA-Z0-9_]+$/.test(name)) {
    throw new Error(
      "Paramètre database invalide (lettres, chiffres, _ uniquement)."
    );
  }
  return name;
}

async function backendFromJsonEntry(
  type: BackendType,
  entry: unknown,
  databaseOverride?: string
): Promise<DatabaseBackend> {
  switch (type) {
    case "hfsql": {
      const { getHfsqlBackendForDsn } = await import("./hfsql-odbc");
      const e = entry as { dsn: string };
      return getHfsqlBackendForDsn(e.dsn);
    }
    case "mysql": {
      const { getMysqlBackendForConfig } = await import("./mysql-backend");
      return getMysqlBackendForConfig(entry as MysqlEntryConfig, databaseOverride);
    }
    case "mssql": {
      const { getMssqlBackendForConfig } = await import("./mssql-backend");
      return getMssqlBackendForConfig(entry as MssqlEntryConfig, databaseOverride);
    }
    default: {
      const _ex: never = type;
      return _ex;
    }
  }
}

export async function resolveBackend(
  type: BackendType,
  opts: { database?: string; connectionName?: string }
): Promise<DatabaseBackend> {
  const fileCfg = loadDatabasesFileConfig();
  const explicitName = opts.connectionName;

  if (explicitName && !fileCfg) {
    throw new Error(
      "Le paramètre name= nécessite un fichier databases.json à la racine du projet (voir databases.example.json)."
    );
  }

  if (fileCfg) {
    const section = fileCfg.databases?.[type];
    const defaultName = fileCfg.defaults?.[type];

    if (explicitName) {
      const found = findEntryInSection(section, explicitName);
      if (!found) {
        const avail = section ? Object.keys(section).join(", ") : "(aucune)";
        throw new Error(
          `Connexion «${explicitName}» introuvable pour type=${type}. Disponibles : ${avail}`
        );
      }
      return backendFromJsonEntry(type, found.entry, opts.database);
    }

    if (typeof defaultName === "string" && defaultName.length > 0) {
      const found = findEntryInSection(section, defaultName);
      if (!found) {
        const avail = section ? Object.keys(section).join(", ") : "(aucune)";
        throw new Error(
          `Défaut defaults.${type}=«${defaultName}» introuvable dans databases.json. Connexions : ${avail}`
        );
      }
      return backendFromJsonEntry(type, found.entry, opts.database);
    }
  }

  switch (type) {
    case "hfsql": {
      const { getHfsqlBackend } = await import("./hfsql-odbc");
      return getHfsqlBackend();
    }
    case "mysql": {
      const { getMysqlBackend } = await import("./mysql-backend");
      return getMysqlBackend(opts.database);
    }
    case "mssql": {
      const { getMssqlBackend } = await import("./mssql-backend");
      return getMssqlBackend(opts.database);
    }
    default: {
      const _exhaustive: never = type;
      return _exhaustive;
    }
  }
}
