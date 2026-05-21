import odbc from "odbc";
import { assertSimpleTableName } from "./identifiers";
import type { DatabaseBackend } from "./types";

/** Une connexion ODBC par chaîne DSN (plusieurs bases HFSQL possibles). */
const connections = new Map<string, odbc.Connection>();

function createBackend(conn: odbc.Connection): DatabaseBackend {
  return {
    async listTables() {
      const tables = await conn.tables(null, null, null, "TABLE");
      return tables.map((t: { TABLE_NAME: string }) => t.TABLE_NAME);
    },

    async describeTable(table: string) {
      assertSimpleTableName(table);
      const cols = await conn.columns(null, null, table, null);
      return cols as Record<string, unknown>[];
    },

    async runSelect(sql: string, limit: number) {
      const safeSql = sql.replace(/^\s*SELECT/i, `SELECT TOP ${limit}`);
      const rows = await conn.query(safeSql);
      return rows as Record<string, unknown>[];
    },
  };
}

export async function getHfsqlBackendForDsn(dsn: string): Promise<DatabaseBackend> {
  if (!connections.has(dsn)) {
    connections.set(dsn, await odbc.connect(dsn));
  }
  const conn = connections.get(dsn)!;
  return createBackend(conn);
}

/** Repli : variable d’environnement `HFSQL_DSN`. */
export async function getHfsqlBackend(): Promise<DatabaseBackend> {
  const dsn = process.env.HFSQL_DSN;
  if (!dsn) {
    throw new Error("HFSQL_DSN non défini dans l'environnement.");
  }
  return getHfsqlBackendForDsn(dsn);
}
