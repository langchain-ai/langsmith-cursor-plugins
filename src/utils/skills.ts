import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { TypedCommand } from "../models/skills.js";
import {
  HOME_PREFIX,
  PATH_SEPARATOR,
  POSIX_SEPARATOR,
  SHELL_CHANGE_DIRECTORY,
  SHELL_QUOTES,
  SHELL_REDIRECT_OPERATOR,
  SHELL_REDIRECT_WORD,
  SHELL_SEPARATORS,
  SHELL_WHITESPACE,
  SKILL_DIRECTORY_NAMES,
  SKILL_FILE_NAME,
  SKILL_FOLDERS,
  SKILL_SHELL_READ_COMMANDS,
  TYPED_SKILL_COMMAND,
} from "../constants.js";

function shellSegments(command: string): string[][] {
  const segments: string[][] = [[]];
  let word = "";
  let inWord = false;
  let quote = "";
  const endWord = () => {
    if (inWord) segments[segments.length - 1].push(word);
    word = "";
    inWord = false;
  };
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = "";
      else word += char;
    } else if (SHELL_QUOTES.has(char)) {
      quote = char;
      inWord = true;
    } else if (SHELL_SEPARATORS.has(char)) {
      endWord();
      segments.push([]);
    } else if (SHELL_WHITESPACE.test(char)) {
      endWord();
    } else {
      word += char;
      inWord = true;
    }
  }
  endWord();
  return segments;
}

function commandName(word: string | undefined): string {
  return word?.split(PATH_SEPARATOR).pop() ?? "";
}

function isRedirectTarget(words: string[], index: number): boolean {
  return (
    SHELL_REDIRECT_WORD.test(words[index]) ||
    (index > 0 && SHELL_REDIRECT_OPERATOR.test(words[index - 1]))
  );
}

function resolveAgainst(directory: string, word: string): string {
  return !directory || isAbsolute(word) || word.startsWith(HOME_PREFIX)
    ? word
    : join(directory, word);
}

export function skillPathFromShellCommand(command: string): string | undefined {
  let directory = "";
  for (const words of shellSegments(command)) {
    if (words[0] === SHELL_CHANGE_DIRECTORY && words[1]) {
      directory = resolveAgainst(directory, words[1]);
      continue;
    }
    if (!SKILL_SHELL_READ_COMMANDS.has(commandName(words[0]))) continue;
    const index = words.findIndex(
      (word, i) => i > 0 && word.endsWith(SKILL_FILE_NAME) && !isRedirectTarget(words, i),
    );
    if (index >= 0) return resolveAgainst(directory, words[index]);
  }
  return undefined;
}

export function isSkillFolder(ancestors: string[]): boolean {
  const rootIndex = ancestors.findIndex((segment) => SKILL_DIRECTORY_NAMES.has(segment));
  if (rootIndex < 0) return false;
  for (let end = ancestors.length; end > rootIndex + 1; end--) {
    const folder = ancestors.slice(0, end).join(POSIX_SEPARATOR);
    if (existsSync(join(folder, SKILL_FILE_NAME))) return false;
  }
  return true;
}

function folderNames(folder: string): string[] {
  try {
    return readdirSync(folder, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function matchName(names: string[], name: string): string | undefined {
  return (
    names.find((entry) => entry === name) ??
    names.find((entry) => entry.toLowerCase() === name.toLowerCase())
  );
}

function hasSkillFile(folder: string, name: string): boolean {
  return existsSync(join(folder, name, SKILL_FILE_NAME));
}

function findInSkillsFolder(folder: string, name: string): string | undefined {
  const children = folderNames(folder);
  const skills = children.filter((child) => hasSkillFile(folder, child));
  const own = matchName(skills, name);
  if (own !== undefined) return own;
  const group = children.find(
    (child) => !skills.includes(child) && hasSkillFile(join(folder, child), name),
  );
  return group === undefined ? undefined : matchName(folderNames(join(folder, group)), name);
}

export function typedCommandOf(prompt: unknown, workspaceRoots: unknown): TypedCommand | undefined {
  const name = typeof prompt === "string" ? TYPED_SKILL_COMMAND.exec(prompt)?.[1] : undefined;
  if (!name) return undefined;
  const roots = Array.isArray(workspaceRoots)
    ? workspaceRoots.filter((root): root is string => typeof root === "string")
    : [];
  return { name, workspaceRoots: roots };
}

export function typedSkillName(command: TypedCommand, home: string): string | undefined {
  try {
    for (const root of [...command.workspaceRoots, home]) {
      for (const folder of SKILL_FOLDERS) {
        const found = findInSkillsFolder(join(root, ...folder), command.name);
        if (found !== undefined) return found;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}
