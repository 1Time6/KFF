-- A browser page uses the existing task/Agent queue and resource leases.
ALTER TABLE kff.collection_runs ADD COLUMN browser_task_id uuid;
ALTER TABLE kff.collection_runs ADD CONSTRAINT collection_runs_browser_task_scope
  FOREIGN KEY (browser_task_id, organization_id, brand_id)
  REFERENCES kff.tasks(id, organization_id, brand_id);
CREATE INDEX collection_runs_browser_task ON kff.collection_runs(browser_task_id)
  WHERE browser_task_id IS NOT NULL;
