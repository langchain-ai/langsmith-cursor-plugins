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

export function skillPathsFromShellCommand(command: string): string[] {
  const paths: string[] = [];
  let directory = "";
  for (const words of shellSegments(command)) {
    if (words[0] === SHELL_CHANGE_DIRECTORY && words[1]) {
      directory = resolveAgainst(directory, words[1]);
    } else if (SKILL_SHELL_READ_COMMANDS.has(commandName(words[0]))) {
      words.forEach((word, i) => {
        if (i > 0 && word.endsWith(SKILL_FILE_NAME) && !isRedirectTarget(words, i)) {
          paths.push(resolveAgainst(directory, word));
        }
      });
    }
  }
  return paths;
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

export function matchingNames(names: string[], name: string): string[] {
  return names.filter((entry) => entry.toLowerCase() === name.toLowerCase());
}

export function pickName(candidates: string[], name: string): string | undefined {
  return candidates.find((candidate) => candidate === name) ?? [...candidates].sort()[0];
}

function skillNamesIn(folder: string): string[] {
  return folderNames(folder).filter((entry) => existsSync(join(folder, entry, SKILL_FILE_NAME)));
}

function findInSkillsFolder(folder: string, name: string): string[] {
  const skills = skillNamesIn(folder);
  const groups = folderNames(folder).filter((child) => !skills.includes(child));
  return [
    ...matchingNames(skills, name),
    ...groups.flatMap((group) => matchingNames(skillNamesIn(join(folder, group)), name)),
  ];
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
  const candidates: string[] = [];
  try {
    for (const root of [...command.workspaceRoots, home]) {
      for (const folder of SKILL_FOLDERS) {
        candidates.push(...findInSkillsFolder(join(root, ...folder), command.name));
      }
    }
  } catch {
    return undefined;
  }
  return pickName(candidates, command.name);
}
