export interface RedactionRule {
  pattern: string;
  replace?: string;
}

export interface LoadConfigOptions {
  cwd?: string;
  includeGitMetadata?: boolean;
}
