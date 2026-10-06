// Row types for the tables the code reads and presents (§5), snake_case as stored.
export type NotificationTypeName = 'filter' | 'event' | 'csv';
export interface NotificationRow {
  id: number;
  type: number;
  image_key: string;
  headline: string;
  subheadline: string;
  link_path: string;
  active: number | boolean;
  removed: number | boolean;
  live_date: Date | null;
  delay: number | null;
  event_trigger: string | null;
  filters: Record<string, unknown> | null;
  went_live_at: Date | null;
  cancelled_before: Date | null;
  request_key: string | null;
  request_endpoint: string | null;
  request_hash: string | null;
  created_at: Date;
}
export interface DeliveryRow {
  id: number;
  public_id: string;
  notification_id: number;
  account_id: number;
  is_clicked: number | boolean;
  sent_at: Date | null;
  due_at: Date;
  occurrence_key: string | null;
  dedupe_key: string;
  created_at: Date;
}
export type ImportStatus = 'processing' | 'completed' | 'failed';
export interface ImportRow {
  id: number;
  notification_id: number;
  status: ImportStatus;
  updated_at: Date;
  total_rows: number;
  accepted: number;
  duplicates_ignored: number;
  request_key: string;
  request_hash: string;
  created_at: Date;
}
