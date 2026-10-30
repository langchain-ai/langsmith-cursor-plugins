import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  BUILT_IN_SKILL_FOLDER,
  SHELL_COMMAND_END,
  SHELL_WORD,
  SKILL_FILE_NAME,
  SKILL_FOLDERS,
  SKILL_SHELL_READ_COMMANDS,
  SYNCED_SKILL_FOLDER,
  TYPED_SKILL_COMMAND,
} from "../constants.js";

/** The SKILL.md a plain read command (`cat path`, `head -50 path`) prints, if it names one. */
export function skillPathFromShellCommand(command: string): string | undefined {
  const [first = ""] = command.split(SHELL_COMMAND_END);
  const words = [...first.matchAll(SHELL_WORD)].map((m) => m[1] ?? m[2] ?? m[0]);
  if (!SKILL_SHELL_READ_COMMANDS.has(words[0] ?? "")) return undefined;
  return words.slice(1).find((word) => word.endsWith(SKILL_FILE_NAME));
}

function syncedIds(syncedRoot: string): string[] {
  try {
    return readdirSync(syncedRoot);
  } catch {
    return [];
  }
}

function skillFolders(roots: string[], home: string): string[] {
  const syncedRoot = join(home, ...SYNCED_SKILL_FOLDER);
  const synced = syncedIds(syncedRoot).map((id) => join(syncedRoot, id));
  return [
    ...[...roots, home].flatMap((root) => SKILL_FOLDERS.map((folder) => join(root, ...folder))),
    join(home, ...BUILT_IN_SKILL_FOLDER),
    ...synced,
  ];
}

/** The skill a prompt starts with as `/name`, only when a skill of that name exists to load. */
export function typedSkillName(
  prompt: string,
  workspaceRoots: string[],
  home: string,
): string | undefined {
  const name = TYPED_SKILL_COMMAND.exec(prompt)?.[1];
  if (!name) return undefined;
  const exists = skillFolders(workspaceRoots, home).some((folder) =>
    existsSync(join(folder, name, SKILL_FILE_NAME)),
  );
  return exists ? name : undefined;
}
