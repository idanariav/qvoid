import { homedir } from "os";
import { join } from "path";

function configBase(): string {
  return process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config");
}

function dataBase(): string {
  return process.env["XDG_DATA_HOME"] ?? join(homedir(), ".local", "share");
}

export function configDir(): string {
  return join(configBase(), "qvoid");
}

export function dataDir(): string {
  return join(dataBase(), "qvoid");
}

export function registryPath(): string {
  return join(configDir(), "collections.toml");
}

export function collectionConfigPath(name: string): string {
  return join(configDir(), "collections", `${name}.toml`);
}

export function collectionDataDir(name: string): string {
  return join(dataDir(), name);
}
