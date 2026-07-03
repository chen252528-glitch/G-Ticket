export interface Env {
  DISCORD_PUBLIC_KEY: string;
  DATABASE_URL: string;
  DATABASE_AUTH_TOKEN: string;
  GITHUB_TOKEN?: string;
  GITHUB_REPOSITORY?: string;
  GITHUB_REF?: string;
}
