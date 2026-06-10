import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { requireWireApi } from "./codex-config.mjs";

export function profileStorePath(codexHome) {
  return path.join(path.resolve(codexHome), "codex-zh", "profiles.json");
}

export function loadProfiles(codexHome) {
  const file = profileStorePath(codexHome);
  if (!existsSync(file)) {
    return { activeProfileId: null, profiles: [] };
  }
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  return {
    activeProfileId: parsed.activeProfileId ?? null,
    profiles: Array.isArray(parsed.profiles) ? parsed.profiles : [],
  };
}

export function saveActiveProfile({ codexHome, profile, now = new Date() }) {
  const file = profileStorePath(codexHome);
  const store = loadProfiles(codexHome);
  const nextProfile = {
    ...profile,
    activatedAt: now.toISOString(),
  };
  const profiles = store.profiles.filter((item) => item.id !== profile.id);
  profiles.push(nextProfile);
  profiles.sort((left, right) => left.id.localeCompare(right.id));

  const nextStore = {
    activeProfileId: profile.id,
    profiles,
  };

  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(nextStore, null, 2)}\n`, "utf8");
  return { path: file, store: nextStore };
}

export function profileFromProviderInput(input) {
  return {
    baseUrl: input.baseUrl,
    id: input.provider,
    model: input.model,
    name: input.providerName ?? input.provider,
    provider: input.provider,
    wireApi: requireWireApi(input.wireApi ?? "responses"),
  };
}
