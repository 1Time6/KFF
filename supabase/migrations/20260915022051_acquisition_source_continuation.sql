-- Add lineage to the existing monitor store; existing RLS and grants remain in force.
ALTER TABLE kff.acquisition_monitors
 ADD COLUMN parent_monitor_id uuid,
 ADD COLUMN parent_monitor_version integer,
 ADD COLUMN source_observation_id uuid,
 ADD COLUMN source_query_id uuid,
 ADD COLUMN derived_source_url text,
 ADD COLUMN derived_expires_at timestamptz,
 ADD CONSTRAINT acquisition_parent_scope FOREIGN KEY(parent_monitor_id,organization_id,brand_id)
   REFERENCES kff.acquisition_monitors(id,organization_id,brand_id),
 ADD CONSTRAINT acquisition_derivation_shape CHECK (
   (parent_monitor_id IS NULL AND parent_monitor_version IS NULL AND source_observation_id IS NULL AND source_query_id IS NULL AND derived_source_url IS NULL AND derived_expires_at IS NULL)
   OR (parent_monitor_id IS NOT NULL AND parent_monitor_id<>id AND parent_monitor_version IS NOT NULL AND parent_monitor_version>0 AND source_observation_id IS NOT NULL AND source_query_id IS NOT NULL AND derived_source_url IS NOT NULL AND derived_expires_at IS NOT NULL)
 ),
 ADD CONSTRAINT acquisition_source_once UNIQUE(parent_monitor_id,derived_source_url);
-- Observation/query IDs are retained as audit references after source retention cleanup.
CREATE INDEX acquisition_derived_expiry ON kff.acquisition_monitors(derived_expires_at) WHERE parent_monitor_id IS NOT NULL AND state='ACTIVE';
