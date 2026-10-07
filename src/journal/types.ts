export type JournalStatus = 'in_progress' | 'completed' | 'failed' | string;

export interface JournalEntry {
  timestamp: string;
  note: string;
  status: JournalStatus;
}

export interface TaskSummary {
  task_id: string;
  created_at: string;
  updated_at: string;
  entry_count: number;
  last_status: JournalStatus;
}

export interface AppendOptions {
  task_id?: string;
  note: string;
  status?: JournalStatus;
}

export interface ReadOptions {
  task_id?: string;
  limit?: number;
}
