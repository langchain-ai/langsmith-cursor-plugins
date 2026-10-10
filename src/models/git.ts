export interface GitRemote {
  name: string;
  url: string;
}

export interface RepositoryIdentity {
  provider: string;
  name: string;
}

export interface GitInfo {
  branch?: string;
  commit?: string;
}
