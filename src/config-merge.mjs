import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const ROOT_SECTION = "";
const ROOT_OWNED_KEYS = new Set(["model", "model_provider", "model_reasoning_effort"]);
const DESKTOP_OWNED_KEYS = new Set(["conversationDetailMode"]);
const PROVIDER_OWNED_KEYS = new Set([
  "base_url",
  "experimental_bearer_token",
  "name",
  "wire_api",
]);

export function mergeCodexConfig(existing, desired) {
  const desiredSections = parseTomlSections(desired);
  const desiredValues = collectOwnedValues(desiredSections);
  const existingSections = parseTomlSections(existing);
  const sectionNames = new Set(existingSections.map((section) => section.name));

  for (const desiredSection of desiredSections) {
    const owned = desiredValues.get(desiredSection.name);
    if (!owned?.size || sectionNames.has(desiredSection.name)) {
      continue;
    }
    existingSections.push({
      headerLine: desiredSection.headerLine,
      lines: Array.from(owned.values()),
      name: desiredSection.name,
    });
    sectionNames.add(desiredSection.name);
  }

  const merged = existingSections
    .map((section) => mergeTomlSection(section, desiredValues.get(section.name)))
    .filter((part, index) => index === 0 || part.trim())
    .join("\n\n")
    .trimEnd();

  return `${merged}\n`;
}

export function writeMergedCodexConfig({
  codexHome,
  desiredConfig,
  now = new Date(),
}) {
  const resolvedHome = path.resolve(codexHome);
  const configPath = path.join(resolvedHome, "config.toml");
  mkdirSync(resolvedHome, { recursive: true });

  let backupPath = null;
  const existing = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  if (existing) {
    backupPath = path.join(configPath + `.bak-${formatTimestamp(now)}`);
    copyFileSync(configPath, backupPath);
  }

  const next = mergeCodexConfig(existing, desiredConfig);
  writeFileSync(configPath, next, "utf8");
  return { backupPath, configPath, codexHome: resolvedHome };
}

export function resolveOfficialCodexHome(env = process.env) {
  if (env.CODEX_HOME?.trim()) {
    return path.resolve(env.CODEX_HOME.trim());
  }
  if (process.platform === "win32") {
    const userProfile = env.USERPROFILE?.trim();
    if (!userProfile) {
      throw new Error("USERPROFILE is required to resolve the Windows Codex home");
    }
    return path.join(userProfile, ".codex");
  }
  const home = env.HOME?.trim();
  if (!home) {
    throw new Error("HOME is required to resolve the Codex home");
  }
  return path.join(home, ".codex");
}

export function parseTomlSections(text) {
  const sections = [{ headerLine: "", lines: [], name: ROOT_SECTION }];
  let current = sections[0];
  for (const line of String(text ?? "").split(/\r?\n/u)) {
    const match = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/u);
    if (match) {
      current = {
        headerLine: line.trimEnd(),
        lines: [],
        name: match[1].trim(),
      };
      sections.push(current);
    } else {
      current.lines.push(line);
    }
  }
  while (sections[0].lines.at(-1) === "") {
    sections[0].lines.pop();
  }
  return sections;
}

function collectOwnedValues(sections) {
  const owned = new Map();
  for (const section of sections) {
    const keys = ownedKeysForSection(section.name);
    if (!keys.size) {
      continue;
    }
    const values = new Map();
    for (const line of section.lines) {
      const key = tomlKey(line);
      if (key && keys.has(key)) {
        values.set(key, line.trimEnd());
      }
    }
    if (values.size) {
      owned.set(section.name, values);
    }
  }
  return owned;
}

function ownedKeysForSection(name) {
  if (name === ROOT_SECTION) {
    return ROOT_OWNED_KEYS;
  }
  if (name === "desktop") {
    return DESKTOP_OWNED_KEYS;
  }
  if (/^model_providers\.[A-Za-z0-9_-]+$/u.test(name)) {
    return PROVIDER_OWNED_KEYS;
  }
  return new Set();
}

function mergeTomlSection(section, ownedValues) {
  const mergedLines = [];
  const remaining = new Map(ownedValues ?? []);
  const seenOwnedKeys = new Set();

  for (const line of section.lines) {
    const key = tomlKey(line);
    if (!key || !ownedValues?.has(key)) {
      mergedLines.push(line);
      continue;
    }
    if (seenOwnedKeys.has(key)) {
      continue;
    }
    mergedLines.push(ownedValues.get(key));
    remaining.delete(key);
    seenOwnedKeys.add(key);
  }

  for (const line of remaining.values()) {
    mergedLines.push(line);
  }

  const body = mergedLines.join("\n").trimEnd();
  if (section.name === ROOT_SECTION) {
    return body;
  }
  return body ? `${section.headerLine}\n${body}` : section.headerLine;
}

function tomlKey(line) {
  const match = String(line).match(/^\s*([A-Za-z0-9_-]+)\s*=/u);
  return match?.[1] ?? null;
}

function formatTimestamp(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}
