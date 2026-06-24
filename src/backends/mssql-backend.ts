import sql from "mssql";
import { assertQualifiedTableName, splitQualifiedTable } from "./identifiers";
import { assertReadOnlySelect } from "./sql-readonly-guard";
import { applySqlServerTop } from "./sqlserver-top";
import type { MssqlEntryConfig } from "../config/databases";
import type { DatabaseBackend } from "./types";

const pools = new Map<string, sql.ConnectionPool>();

function poolKey(server: string, port: number, database: string, user: string) {
  return `${server}:${port}:${database}:${user}`;
}

function createMssqlBackend(pool: sql.ConnectionPool): DatabaseBackend {
  return {
    /** Liste toutes les tables de la base de données. */
    async listTables() {
      const result = await pool.request().query<{
        TABLE_SCHEMA: string;
        TABLE_NAME: string;
      }>(
        `SELECT TABLE_SCHEMA, TABLE_NAME
         FROM INFORMATION_SCHEMA.TABLES
         WHERE TABLE_TYPE = 'BASE TABLE'
         ORDER BY TABLE_SCHEMA, TABLE_NAME`
      );
      return result.recordset.map(
        (r) => `${r.TABLE_SCHEMA}.${r.TABLE_NAME}`
      );
    },

    /** Décrit les colonnes d'une table. */
    async describeTable(table: string) {
      assertQualifiedTableName(table);
      const { schema, name } = splitQualifiedTable(table);
      const req = pool.request().input("tableName", sql.NVarChar, name);
      if (schema) {
        req.input("tableSchema", sql.NVarChar, schema);
      }
      const result = await req.query<Record<string, unknown>>(
        schema
          ? `SELECT c.COLUMN_NAME, c.DATA_TYPE, c.IS_NULLABLE, c.COLUMN_DEFAULT,
                    c.CHARACTER_MAXIMUM_LENGTH, c.ORDINAL_POSITION
             FROM INFORMATION_SCHEMA.COLUMNS c
             INNER JOIN INFORMATION_SCHEMA.TABLES t
               ON c.TABLE_SCHEMA = t.TABLE_SCHEMA AND c.TABLE_NAME = t.TABLE_NAME
             WHERE t.TABLE_TYPE = 'BASE TABLE'
               AND c.TABLE_NAME = @tableName
               AND c.TABLE_SCHEMA = @tableSchema
             ORDER BY c.ORDINAL_POSITION`
          : `SELECT c.COLUMN_NAME, c.DATA_TYPE, c.IS_NULLABLE, c.COLUMN_DEFAULT,
                    c.CHARACTER_MAXIMUM_LENGTH, c.ORDINAL_POSITION
             FROM INFORMATION_SCHEMA.COLUMNS c
             INNER JOIN INFORMATION_SCHEMA.TABLES t
               ON c.TABLE_SCHEMA = t.TABLE_SCHEMA AND c.TABLE_NAME = t.TABLE_NAME
             WHERE t.TABLE_TYPE = 'BASE TABLE'
               AND c.TABLE_NAME = @tableName
               AND t.TABLE_SCHEMA = SCHEMA_NAME()
             ORDER BY c.ORDINAL_POSITION`
      );
      return result.recordset;
    },

    /** Exécute une requête SELECT uniquement. */
    async runSelect(sqlText: string, limit: number) {
      assertReadOnlySelect(sqlText);
      const safeSql = applySqlServerTop(sqlText, limit);
      const result = await pool.request().query(safeSql);
      return result.recordset as Record<string, unknown>[];
    },
  };
}

/** Connexion décrite dans `databases.json` (ou équivalent). */
export async function getMssqlBackendForConfig(
  cfg: MssqlEntryConfig,
  databaseOverride?: string
): Promise<DatabaseBackend> {
  const database = databaseOverride ?? cfg.database;
  const port = cfg.port ?? 1433;
  const password = cfg.password ?? "";
  const encrypt = cfg.encrypt ?? process.env.MSSQL_ENCRYPT !== "false";
  const trustServerCertificate =
    cfg.trustServerCertificate ??
    process.env.MSSQL_TRUST_SERVER_CERTIFICATE === "true";

  const key = poolKey(cfg.server, port, database, cfg.user);
  let pool = pools.get(key);
  if (!pool) {
    pool = new sql.ConnectionPool({
      user: cfg.user,
      password,
      server: cfg.server,
      port,
      database,
      options: {
        encrypt,
        trustServerCertificate,
      },
    });
    await pool.connect();
    pools.set(key, pool);
  }
  return createMssqlBackend(pool);
}

/** Repli : variables `MSSQL_*` dans `.env`. */
export async function getMssqlBackend(
  databaseOverride?: string
): Promise<DatabaseBackend> {
  const server = process.env.MSSQL_SERVER;
  if (!server) {
    throw new Error("MSSQL_SERVER non défini.");
  }
  const user = process.env.MSSQL_USER;
  if (!user) {
    throw new Error("MSSQL_USER non défini.");
  }
  const password = process.env.MSSQL_PASSWORD ?? "";
  const port = process.env.MSSQL_PORT ? parseInt(process.env.MSSQL_PORT, 10) : 1433;
  const database =
    databaseOverride ?? process.env.MSSQL_DATABASE ?? "master";

  const cfg: MssqlEntryConfig = {
    server,
    port,
    user,
    password,
    database,
    encrypt: process.env.MSSQL_ENCRYPT !== "false",
    trustServerCertificate:
      process.env.MSSQL_TRUST_SERVER_CERTIFICATE === "true",
  };
  return getMssqlBackendForConfig(cfg);
}
