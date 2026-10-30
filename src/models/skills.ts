export type PathSegments = readonly string[];

export interface TypedCommand {
  name: string;
  workspaceRoots: string[];
}

export interface SearchBudget {
  entriesLeft: number;
}
