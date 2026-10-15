export const CURRENT_PBKDF2_ITERATIONS: number;
export const CURRENT_HASH_VERSION: number;

export function hashPassword(password: string): Promise<{ hash: string; salt: string }>;

export function generateBootstrapAdminSql(
  username: string,
  password: string
): Promise<{
  adminId: string;
  username: string;
  hash: string;
  salt: string;
  sqlStatements: string[];
  fullSql: string;
}>;
