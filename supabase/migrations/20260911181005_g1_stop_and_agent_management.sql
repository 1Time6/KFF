ALTER TABLE kff.organizations ADD COLUMN outbound_paused boolean NOT NULL DEFAULT false;
ALTER TABLE kff.accounts ADD COLUMN outbound_paused boolean NOT NULL DEFAULT false;
CREATE TABLE kff.organization_memberships (
  organization_id uuid NOT NULL REFERENCES kff.organizations(id), user_id uuid NOT NULL,
  role text NOT NULL CHECK(role IN ('owner','admin','member')), PRIMARY KEY(organization_id,user_id)
);
ALTER TABLE kff.organization_memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_organization_membership ON kff.organization_memberships TO kff_app USING(organization_id=nullif(current_setting('kff.organization_id',true),'')::uuid AND user_id=nullif(current_setting('kff.user_id',true),'')::uuid);
GRANT SELECT ON kff.organization_memberships TO kff_app;
ALTER TABLE kff.organizations ENABLE ROW LEVEL SECURITY;
CREATE POLICY organization_scope ON kff.organizations TO kff_app USING(id=nullif(current_setting('kff.organization_id',true),'')::uuid);
GRANT SELECT ON kff.organizations TO kff_app;
