import mysql from "mysql2/promise";
import { assertQualifiedTableName, splitQualifiedTable } from "./identifiers";
import type { MysqlEntryConfig } from "../config/databases";
import type { DatabaseBackend } from "./types";

const pools = new Map<string, mysql.Pool>();

function applyMysqlLimit(sql: string, limit: number): string {
  const trimmed = sql.trim();
  if (/\blimit\s+\d+/i.test(trimmed)) {
    return trimmed;
  }
  return `${trimmed} LIMIT ${limit}`;
}

function poolKey(host: string, port: number, user: string, database: string) {
  return `${host}:${port}:${user}:${database}`;
}

function createMysqlBackend(pool: mysql.Pool): DatabaseBackend {
  return {
    async listTables() {
      const [rows] = await pool.query<mysql.RowDataPacket[]>(
        `SELECT TABLE_NAME AS TABLE_NAME
         FROM INFORMATION_SCHEMA.TABLES
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_TYPE = 'BASE TABLE'
         ORDER BY TABLE_NAME`
      );
      return rows.map((r) => String(r.TABLE_NAME));
    },

    async describeTable(table: string) {
      assertQualifiedTableName(table);
      const { schema, name } = splitQualifiedTable(table);
      const [rows] = await pool.query<mysql.RowDataPacket[]>(
        `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, EXTRA, CHARACTER_MAXIMUM_LENGTH
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ?
         ORDER BY ORDINAL_POSITION`,
        [schema, name]
      );
      return rows as Record<string, unknown>[];
    },

    async runSelect(sql: string, limit: number) {
      const safeSql = applyMysqlLimit(sql, limit);
      const [rows] = await pool.query<mysql.RowDataPacket[]>(safeSql);
      return rows as Record<string, unknown>[];
    },
  };
}

/** Connexion décrite dans `databases.json` (ou équivalent). */
export async function getMysqlBackendForConfig(
  cfg: MysqlEntryConfig,
  databaseOverride?: string
): Promise<DatabaseBackend> {
  const database = databaseOverride ?? cfg.database;
  const port = cfg.port ?? 3306;
  const password = cfg.password ?? "";
  const key = poolKey(cfg.host, port, cfg.user, database);
  let pool = pools.get(key);
  if (!pool) {
    pool = mysql.createPool({
      host: cfg.host,
      port,
      user: cfg.user,
      password,
      database,
      waitForConnections: true,
      connectionLimit: 10,
    });
    pools.set(key, pool);
  }
  return createMysqlBackend(pool);
}

/** Repli : variables `MYSQL_*` dans `.env`. */
export async function getMysqlBackend(
  databaseOverride?: string
): Promise<DatabaseBackend> {
  const host = process.env.MYSQL_HOST;
  if (!host) {
    throw new Error("MYSQL_HOST non défini.");
  }
  const user = process.env.MYSQL_USER;
  if (!user) {
    throw new Error("MYSQL_USER non défini.");
  }
  const password = process.env.MYSQL_PASSWORD ?? "";
  const port = process.env.MYSQL_PORT ? parseInt(process.env.MYSQL_PORT, 10) : 3306;
  const database =
    databaseOverride ?? process.env.MYSQL_DATABASE ?? "";
  if (!database) {
    throw new Error(
      "Base MySQL : définir MYSQL_DATABASE dans .env ou le paramètre d'URL database=."
    );
  }

  const cfg: MysqlEntryConfig = {
    host,
    port,
    user,
    password,
    database,
  };
  return getMysqlBackendForConfig(cfg);
}
