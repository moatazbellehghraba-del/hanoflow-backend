-- Prerequisites: reviewed cluster roles and explicit database/schema grants.
-- No credentials, cluster roles, database ownership or fixture policies here.
BEGIN;
-- The controlled provisioner creates this exact schema; migrator does not need
-- database CREATE privilege or authority to create arbitrary schemas.
REVOKE ALL ON SCHEMA hf_security FROM PUBLIC;
GRANT USAGE ON SCHEMA hf_security TO hanoflow_runtime, hanoflow_bootstrap;

CREATE FUNCTION hf_security.context_uuid(key text) RETURNS uuid
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
 SELECT CASE WHEN current_setting(key,true) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 THEN current_setting(key,true)::uuid ELSE NULL END
$$;
CREATE FUNCTION hf_security.tenant() RETURNS uuid
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
 SELECT CASE WHEN current_setting('app.access_path',true)='tenant'
 THEN hf_security.context_uuid('app.tenant_id') ELSE NULL END
$$;
CREATE FUNCTION hf_security.lookup_digest() RETURNS bytea
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
 SELECT CASE WHEN current_setting('app.access_path',true)='session'
 AND current_setting('app.token_digest',true) ~ '^[0-9a-f]{64}$'
 THEN decode(current_setting('app.token_digest',true),'hex') ELSE NULL END
$$;
CREATE FUNCTION hf_security.immutable_id() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
 IF NEW.id IS DISTINCT FROM OLD.id THEN
  RAISE EXCEPTION 'Primary identifier is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END
$$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA hf_security FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hf_security.context_uuid(text),hf_security.tenant(),hf_security.lookup_digest(),hf_security.immutable_id() TO hanoflow_runtime,hanoflow_bootstrap;
CREATE TRIGGER user_immutable_id BEFORE UPDATE OF id ON public."User"
 FOR EACH ROW EXECUTE FUNCTION hf_security.immutable_id();
CREATE TRIGGER tenant_immutable_id BEFORE UPDATE OF id ON public."Tenant"
 FOR EACH ROW EXECUTE FUNCTION hf_security.immutable_id();

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['User','PasswordCredential','Session','AccessToken','RefreshToken','Tenant','Membership','Role','MembershipRole','RolePermission','Permission','AuditEvent'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 END LOOP;
END $$;

-- Dependency DAG: User/Tenant -> Membership; token -> Session. Membership and
-- Session policies reference only context values. No policy reads its own table.
CREATE POLICY membership_runtime_select ON public."Membership" FOR SELECT TO hanoflow_runtime
 USING ("tenantId"=hf_security.tenant() OR
 (current_setting('app.access_path',true)='session' AND "userId"=hf_security.context_uuid('app.user_id')));
CREATE POLICY membership_runtime_update ON public."Membership" FOR UPDATE TO hanoflow_runtime
 USING ("tenantId"=hf_security.tenant() OR
 (current_setting('app.access_path',true)='session' AND "userId"=hf_security.context_uuid('app.user_id')))
 WITH CHECK ("tenantId"=hf_security.tenant());
CREATE POLICY user_runtime_select ON public."User" FOR SELECT TO hanoflow_runtime
 USING (id=hf_security.context_uuid('app.user_id') OR EXISTS
 (SELECT 1 FROM public."Membership" m WHERE m."userId"="User".id AND m."tenantId"=hf_security.tenant()));
CREATE POLICY user_runtime_lock ON public."User" FOR UPDATE TO hanoflow_runtime
 USING (id=hf_security.context_uuid('app.user_id')) WITH CHECK (id=hf_security.context_uuid('app.user_id'));
CREATE POLICY tenant_runtime_select ON public."Tenant" FOR SELECT TO hanoflow_runtime
 USING (id=hf_security.tenant() OR (current_setting('app.access_path',true)='session' AND EXISTS
 (SELECT 1 FROM public."Membership" m WHERE m."tenantId"="Tenant".id AND m."userId"=hf_security.context_uuid('app.user_id'))));
CREATE POLICY tenant_runtime_lock ON public."Tenant" FOR UPDATE TO hanoflow_runtime
 USING (id=hf_security.tenant() OR (current_setting('app.access_path',true)='session' AND EXISTS
 (SELECT 1 FROM public."Membership" m WHERE m."tenantId"="Tenant".id AND m."userId"=hf_security.context_uuid('app.user_id'))))
 WITH CHECK (id=hf_security.tenant() OR (current_setting('app.access_path',true)='session' AND EXISTS
 (SELECT 1 FROM public."Membership" m WHERE m."tenantId"="Tenant".id AND m."userId"=hf_security.context_uuid('app.user_id'))));

CREATE POLICY session_runtime_select ON public."Session" FOR SELECT TO hanoflow_runtime
 USING (id=hf_security.context_uuid('app.session_id') OR "userId"=hf_security.context_uuid('app.user_id'));
CREATE POLICY session_runtime_insert ON public."Session" FOR INSERT TO hanoflow_runtime
 WITH CHECK ("userId"=hf_security.context_uuid('app.user_id') AND scope::text='IDENTITY' AND "tenantId" IS NULL AND "membershipId" IS NULL);
CREATE POLICY session_runtime_update ON public."Session" FOR UPDATE TO hanoflow_runtime
 USING ("userId"=hf_security.context_uuid('app.user_id'))
 WITH CHECK ("userId"=hf_security.context_uuid('app.user_id'));
CREATE POLICY access_runtime_select ON public."AccessToken" FOR SELECT TO hanoflow_runtime
 USING (digest=hf_security.lookup_digest() OR "sessionId"=hf_security.context_uuid('app.session_id'));
CREATE POLICY access_runtime_insert ON public."AccessToken" FOR INSERT TO hanoflow_runtime
 WITH CHECK ("sessionId"=hf_security.context_uuid('app.session_id') AND EXISTS
 (SELECT 1 FROM public."Session" s WHERE s.id="AccessToken"."sessionId" AND s."userId"=hf_security.context_uuid('app.user_id') AND s."contextVersion"="AccessToken"."contextVersion"));
CREATE POLICY refresh_runtime_select ON public."RefreshToken" FOR SELECT TO hanoflow_runtime
 USING (digest=hf_security.lookup_digest() OR "sessionId"=hf_security.context_uuid('app.session_id'));
CREATE POLICY refresh_runtime_insert ON public."RefreshToken" FOR INSERT TO hanoflow_runtime
 WITH CHECK ("sessionId"=hf_security.context_uuid('app.session_id') AND EXISTS
 (SELECT 1 FROM public."Session" s WHERE s.id="RefreshToken"."sessionId" AND s."userId"=hf_security.context_uuid('app.user_id') AND s."contextVersion"="RefreshToken"."contextVersion"));
CREATE POLICY refresh_runtime_update ON public."RefreshToken" FOR UPDATE TO hanoflow_runtime
 USING ("sessionId"=hf_security.context_uuid('app.session_id'))
 WITH CHECK ("sessionId"=hf_security.context_uuid('app.session_id'));

CREATE POLICY role_runtime_select ON public."Role" FOR SELECT TO hanoflow_runtime USING ("tenantId"=hf_security.tenant());
CREATE POLICY role_permission_runtime_select ON public."RolePermission" FOR SELECT TO hanoflow_runtime USING ("tenantId"=hf_security.tenant());
CREATE POLICY membership_role_runtime_select ON public."MembershipRole" FOR SELECT TO hanoflow_runtime USING ("tenantId"=hf_security.tenant());
CREATE POLICY membership_role_runtime_insert ON public."MembershipRole" FOR INSERT TO hanoflow_runtime
 WITH CHECK ("tenantId"=hf_security.tenant() AND "grantedByUserId"=hf_security.context_uuid('app.user_id') AND "removedAt" IS NULL AND "removedByUserId" IS NULL);
CREATE POLICY membership_role_runtime_update ON public."MembershipRole" FOR UPDATE TO hanoflow_runtime
 USING ("tenantId"=hf_security.tenant() AND "removedAt" IS NULL)
 WITH CHECK ("tenantId"=hf_security.tenant() AND "removedByUserId"=hf_security.context_uuid('app.user_id') AND "removedAt" IS NOT NULL);
CREATE POLICY permission_runtime_select ON public."Permission" FOR SELECT TO hanoflow_runtime,hanoflow_bootstrap
 USING (scope::text='TENANT' AND code IN ('tenant.memberships.read','tenant.memberships.manage','tenant.roles.read','tenant.roles.assign','tenant.ownership.manage'));

-- Runtime audit is insert-only: no SELECT policy or grant (including RETURNING).
CREATE POLICY audit_runtime_insert ON public."AuditEvent" FOR INSERT TO hanoflow_runtime WITH CHECK (
 (scope::text='TENANT' AND "tenantId"=hf_security.tenant() AND "actorUserId"=hf_security.context_uuid('app.user_id')
  AND action IN ('tenant.role_assigned','tenant.role_removed','tenant.membership_status_changed','tenant.context_selected') AND outcome::text='SUCCESS')
 OR (scope::text='PLATFORM' AND "tenantId" IS NULL AND current_setting('app.access_path',true)='session'
  AND ((action IN ('session.established','session.rotated','session.revoked') AND "actorUserId"=hf_security.context_uuid('app.user_id') AND "targetType"='Session' AND "targetId"=hf_security.context_uuid('app.session_id')::text AND outcome::text='SUCCESS')
   OR (action='session.revoked_all' AND "actorUserId"=hf_security.context_uuid('app.user_id') AND "targetType"='User' AND "targetId"=hf_security.context_uuid('app.user_id')::text AND outcome::text='SUCCESS')
   OR (action='session.refresh_replay' AND "actorUserId" IS NULL AND "targetType"='Session' AND "targetId"=hf_security.context_uuid('app.session_id')::text AND outcome::text='DENIED'))));

CREATE POLICY tenant_bootstrap_select ON public."Tenant" FOR SELECT TO hanoflow_bootstrap
 USING (id=hf_security.context_uuid('app.bootstrap_tenant_id'));
CREATE POLICY tenant_bootstrap_lock ON public."Tenant" FOR UPDATE TO hanoflow_bootstrap
 USING (id=hf_security.context_uuid('app.bootstrap_tenant_id')) WITH CHECK (id=hf_security.context_uuid('app.bootstrap_tenant_id'));
CREATE POLICY role_bootstrap_select ON public."Role" FOR SELECT TO hanoflow_bootstrap
 USING ("tenantId"=hf_security.context_uuid('app.bootstrap_tenant_id'));
CREATE POLICY role_bootstrap_insert ON public."Role" FOR INSERT TO hanoflow_bootstrap
 WITH CHECK ("tenantId"=hf_security.context_uuid('app.bootstrap_tenant_id') AND EXISTS
 (SELECT 1 FROM public."Tenant" t WHERE t.id="Role"."tenantId" AND t.status::text='PENDING'));
CREATE POLICY role_permission_bootstrap_select ON public."RolePermission" FOR SELECT TO hanoflow_bootstrap
 USING ("tenantId"=hf_security.context_uuid('app.bootstrap_tenant_id'));
CREATE POLICY role_permission_bootstrap_insert ON public."RolePermission" FOR INSERT TO hanoflow_bootstrap
 WITH CHECK ("tenantId"=hf_security.context_uuid('app.bootstrap_tenant_id') AND EXISTS
 (SELECT 1 FROM public."Tenant" t WHERE t.id="RolePermission"."tenantId" AND t.status::text='PENDING'));
CREATE POLICY audit_bootstrap_insert ON public."AuditEvent" FOR INSERT TO hanoflow_bootstrap
 WITH CHECK (scope::text='TENANT' AND "tenantId"=hf_security.context_uuid('app.bootstrap_tenant_id') AND "actorUserId" IS NULL AND action='tenant.roles_provisioned' AND "targetType"='Tenant' AND "targetId"="tenantId"::text AND outcome::text='SUCCESS'
 AND EXISTS (SELECT 1 FROM public."Tenant" t WHERE t.id="AuditEvent"."tenantId" AND t.status::text='PENDING'));

GRANT SELECT (id,status,"emailVerifiedAt"),UPDATE(id) ON public."User" TO hanoflow_runtime;
GRANT SELECT,UPDATE(id) ON public."Tenant" TO hanoflow_runtime;
GRANT SELECT,UPDATE(status,"removedAt","updatedAt") ON public."Membership" TO hanoflow_runtime;
GRANT SELECT ON public."Role",public."RolePermission",public."Permission" TO hanoflow_runtime;
GRANT SELECT,INSERT,UPDATE("removedAt","removedByUserId") ON public."MembershipRole" TO hanoflow_runtime;
GRANT SELECT,INSERT,UPDATE(scope,"tenantId","membershipId","contextVersion","lastActivityAt","idleExpiresAt","revokedAt","revocationReason") ON public."Session" TO hanoflow_runtime;
GRANT SELECT,INSERT ON public."AccessToken" TO hanoflow_runtime;
GRANT SELECT,INSERT,UPDATE("consumedAt") ON public."RefreshToken" TO hanoflow_runtime;
GRANT INSERT ON public."AuditEvent" TO hanoflow_runtime;
GRANT SELECT,UPDATE(id) ON public."Tenant" TO hanoflow_bootstrap;
GRANT SELECT ON public."Permission" TO hanoflow_bootstrap;
GRANT SELECT,INSERT ON public."Role",public."RolePermission" TO hanoflow_bootstrap;
GRANT INSERT ON public."AuditEvent" TO hanoflow_bootstrap;
ALTER DEFAULT PRIVILEGES FOR ROLE hanoflow_migrator IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE hanoflow_migrator IN SCHEMA hf_security REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
COMMIT;
