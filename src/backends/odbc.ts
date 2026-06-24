import odbc from "odbc";
import { assertSimpleTableName } from "./identifiers";
import { assertReadOnlySelect } from "./sql-readonly-guard";
import { applySqlServerTop } from "./sqlserver-top";
import type { DatabaseBackend } from "./types";

/** Une connexion ODBC par chaîne DSN (plusieurs bases ODBC possibles). */
const connections = new Map<string, odbc.Connection>();

const ODBC_HINT =
  "Sous Windows : créer le DSN en source « Système » (pas seulement utilisateur) dans odbcad32 64 bits si Node est 64 bits ; le compte du service (IIS APPPOOL\\…, SYSTEM, etc.) doit voir le même DSN que celui testé en console.";

function formatOdbcConnectError(dsn: string, err: unknown): Error {
  const base = err instanceof Error ? err.message : String(err);
  const safe = dsn.replace(/password=[^;]*/gi, "password=***");
  return new Error(`${base} (DSN : ${safe}). ${ODBC_HINT}`);
}

function createBackend(conn: odbc.Connection): DatabaseBackend {
  return {
    /** Liste toutes les tables de la base de données. */
    async listTables() {
      const tables = await conn.tables(null, null, null, "TABLE");
      return tables.map((t: { TABLE_NAME: string }) => t.TABLE_NAME);
    },

    /** Décrit les colonnes d'une table. */
    async describeTable(table: string) {
      assertSimpleTableName(table);
      const cols = await conn.columns(null, null, table, null);
      return cols as Record<string, unknown>[];
    },

    /** Exécute une requête SELECT uniquement. */
    async runSelect(sql: string, limit: number) {
      assertReadOnlySelect(sql);
      const safeSql = applySqlServerTop(sql, limit);
      const rows = await conn.query(safeSql);
      return rows as Record<string, unknown>[];
    },
  };
}

export async function getOdbcBackendForDsn(dsn: string): Promise<DatabaseBackend> {
  if (!connections.has(dsn)) {
    try {
      connections.set(dsn, await odbc.connect(dsn));
    } catch (e) {
      throw formatOdbcConnectError(dsn, e);
    }
  }
  const conn = connections.get(dsn)!;
  return createBackend(conn);
}

/** Repli : variable d’environnement `ODBC_DSN`. */
export async function getOdbcBackend(): Promise<DatabaseBackend> {
  const dsn = process.env.ODBC_DSN;
  if (!dsn) {
    throw new Error("ODBC_DSN non défini dans l'environnement.");
  }
  return getOdbcBackendForDsn(dsn);
}
