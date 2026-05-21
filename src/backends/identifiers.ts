/** HFSQL / ODBC : nom de table simple uniquement. */
export function assertSimpleTableName(table: string) {
  if (!/^[a-zA-Z0-9_]+$/.test(table)) {
    throw new Error("Nom de table invalide (lettres, chiffres, _ uniquement).");
  }
}

/** MySQL / MSSQL : `table` ou `schema.table`. */
export function assertQualifiedTableName(table: string) {
  if (!/^[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+)?$/.test(table)) {
    throw new Error(
      "Nom de table invalide : utilisez lettres, chiffres, _ ou schema.table."
    );
  }
}

export function splitQualifiedTable(table: string): {
  schema: string | null;
  name: string;
} {
  assertQualifiedTableName(table);
  const idx = table.indexOf(".");
  if (idx === -1) return { schema: null, name: table };
  return { schema: table.slice(0, idx), name: table.slice(idx + 1) };
}
