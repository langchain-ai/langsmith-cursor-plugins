import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  PATH_SEPARATOR,
  SHELL_CHANGE_DIRECTORY,
  SHELL_QUOTES,
  SHELL_REDIRECT_OPERATOR,
  SHELL_REDIRECT_WORD,
  SHELL_SEPARATORS,
  SHELL_WHITESPACE,
  SKILL_FILE_NAME,
  SKILL_FOLDERS,
  SKILL_SEARCH_DEPTH,
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

export function skillPathFromShellCommand(command: string): string | undefined {
  let directory = "";
  for (const words of shellSegments(command)) {
    if (words[0] === SHELL_CHANGE_DIRECTORY && words[1]) {
      directory = words[1].startsWith("/") ? words[1] : join(directory, words[1]);
      continue;
    }
    if (!SKILL_SHELL_READ_COMMANDS.has(commandName(words[0]))) continue;
    const index = words.findIndex(
      (word, i) => i > 0 && word.endsWith(SKILL_FILE_NAME) && !isRedirectTarget(words, i),
    );
    if (index < 0) continue;
    return words[index].startsWith("/") || !directory
      ? words[index]
      : join(directory, words[index]);
  }
  return undefined;
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

function findSkillFolderName(folder: string, name: string, depth: number): string | undefined {
  const names = folderNames(folder);
  const own =
    names.find((entry) => entry === name) ??
    names.find((entry) => entry.toLowerCase() === name.toLowerCase());
  if (own !== undefined && existsSync(join(folder, own, SKILL_FILE_NAME))) return own;
  if (depth <= 1) return undefined;
  for (const entry of names) {
    const found = findSkillFolderName(join(folder, entry), name, depth - 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

export function typedSkillName(
  prompt: string,
  workspaceRoots: string[],
  home: string,
): string | undefined {
  const name = TYPED_SKILL_COMMAND.exec(prompt)?.[1];
  if (!name) return undefined;
  for (const root of [...workspaceRoots, home]) {
    for (const folder of SKILL_FOLDERS) {
      const found = findSkillFolderName(join(root, ...folder), name, SKILL_SEARCH_DEPTH);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}
