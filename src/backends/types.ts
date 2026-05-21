export type BackendType = "hfsql" | "mysql" | "mssql";

/** Accès lecture / métadonnées, indépendant du moteur sous-jacent. */
export interface DatabaseBackend {
  listTables(): Promise<string[]>;
  describeTable(table: string): Promise<Record<string, unknown>[]>;
  runSelect(sql: string, limit: number): Promise<Record<string, unknown>[]>;
}
