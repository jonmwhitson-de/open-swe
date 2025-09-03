const envFlag =
  process.env.ENABLE_GITHUB ?? process.env.NEXT_PUBLIC_ENABLE_GITHUB;
export const ENABLE_GITHUB = envFlag !== "false" && envFlag !== "0";
