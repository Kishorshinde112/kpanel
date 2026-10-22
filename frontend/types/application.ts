export type BuildType = 'dockerfile' | 'railpack' | 'compose';

export interface GitApplication {
  id: string;
  name: string;
  slug: string;
  repo_url: string;
  branch: string;
  build_type: BuildType;
  build_path: string;
  port: number;
  domain: string | null;
  cpu_limit: number;
  memory_limit_mb: number;
  active_release_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateApplicationInput {
  name: string;
  slug?: string;
  repo_url: string;
  branch?: string;
  build_type?: BuildType;
  build_path?: string;
  port?: number;
  domain?: string;
  cpu_limit?: number;
  memory_limit_mb?: number;
}

export interface ApplicationPagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface ApplicationsListResponse {
  data: GitApplication[];
  pagination: ApplicationPagination;
}
