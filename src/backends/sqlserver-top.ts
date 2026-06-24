/**
 * SQL Server / ODBC (T-SQL) : injecte TOP et retire un LIMIT style MySQL en fin de requête,
 * pour éviter `SELECT TOP n ... LIMIT m` (syntaxe invalide) quand les modèles génèrent du SQL type MySQL/Postgres.
 */

/** Espaces « exotiques » (copier-coller, Word) pour que `\s+LIMIT` matche comme un espace classique. */
const UNICODE_SPACE_LIKE = /[\u00a0\u1680\u2000-\u200b\u202f\u205f\u3000\ufeff]/g;

function normalizeSqlSpaces(s: string): string {
  return s.replace(UNICODE_SPACE_LIKE, " ");
}

export function applySqlServerTop(sql: string, maxRows: number): string {
  let text = normalizeSqlSpaces(sql).trim().replace(/;+\s*$/, "");
  let cap = maxRows;

  const simpleLimit = /\s+LIMIT\s+(\d+)\s*;?\s*$/i;
  const m = text.match(simpleLimit);
  if (m) {
    cap = Math.min(maxRows, parseInt(m[1], 10));
    text = text.replace(simpleLimit, "");
  }

  return text.replace(/^\s*SELECT/i, `SELECT TOP ${cap}`);
}
