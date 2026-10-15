export const CURRENT_PBKDF2_ITERATIONS: number;
export const CURRENT_HASH_VERSION: number;

export function hashPassword(password: string): Promise<{ hash: string; salt: string }>;

export function generateRecoverySuperAdminSql(
  username: string,
  newPassword: string
): Promise<{
  username: string;
  hash: string;
  salt: string;
  sqlStatements: string[];
  fullSql: string;
}>;
