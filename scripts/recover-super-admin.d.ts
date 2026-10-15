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

export function parseRecoveryArgs(args?: string[]): {
  username: string;
  outputFile: string;
};

export function promptHiddenPassword(questionText: string): Promise<string>;
export function promptQuestion(questionText: string): Promise<string>;
