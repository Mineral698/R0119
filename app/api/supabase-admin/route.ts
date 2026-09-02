import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";

// Supabase 管理 API 代理：api.supabase.com 不对第三方站点返回 CORS 放行头，
// 浏览器直连会被拦，与微信/推送的一键部署走服务端转发是同一原因。
// Access Token 与取回的 service_role key 均只在本次请求中透传，不存储、不记录。

export const runtime = "nodejs";

const MANAGEMENT_API = "https://api.supabase.com/v1";
const PERSONAL_CLOUD_PROJECT_NAME = "AI Phone Personal Cloud";

type AdminPayload = {
  action?: string;
  token?: string;
  projectRef?: string;
  organizationSlug?: string;
  regionCode?: string;
  sql?: string;
};

function cleanToken(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function cleanProjectRef(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  return /^[a-z0-9]{16,24}$/.test(raw) ? raw : "";
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isOrganizationId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function cleanOrganizationSlug(value: unknown): string {
  const raw = asString(value);
  if (isOrganizationId(raw)) return raw.toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{1,79}$/i.test(raw) ? raw.toLowerCase() : "";
}

function cleanRegionCode(value: unknown): "americas" | "emea" | "apac" {
  return value === "americas" || value === "emea" || value === "apac" ? value : "apac";
}

async function upstreamMessage(response: Response): Promise<string> {
  try {
    const data = await response.json() as { message?: unknown; error?: unknown };
    const message = typeof data.message === "string" ? data.message : typeof data.error === "string" ? data.error : "";
    return message || `Supabase 管理接口返回 HTTP ${response.status}`;
  } catch {
    return `Supabase 管理接口返回 HTTP ${response.status}`;
  }
}

async function managementFetch(token: string, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${MANAGEMENT_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
}

type ListedProject = { ref: string; name: string; organizationId: string; organizationSlug: string };

function asObjectArray(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.data)) return asObjectArray(record.data);
    if (Array.isArray(record.items)) return asObjectArray(record.items);
    if (Array.isArray(record.organizations)) return asObjectArray(record.organizations);
    if (Array.isArray(record.projects)) return asObjectArray(record.projects);
    if (record.data && typeof record.data === "object") return asObjectArray(record.data);
    if (asString(record.id) || asString(record.slug) || asString(record.organization_slug) || asString(record.ref)) {
      return [record];
    }
  }
  return [];
}

type ListedOrganization = { id: string; slug: string; name: string };

function parseOrganization(item: Record<string, unknown>): ListedOrganization | null {
  const nested = item.organization && typeof item.organization === "object"
    ? item.organization as Record<string, unknown>
    : item;
  const id = asString(nested.id) || asString(item.organization_id);
  const slug = asString(nested.slug) || asString(item.organization_slug) || id;
  const name = asString(nested.name) || asString(item.name) || slug;
  if (!slug) return null;
  return { id: id || slug, slug, name };
}

function parseOrganizations(value: unknown): ListedOrganization[] {
  return asObjectArray(value).map(parseOrganization).filter((item): item is ListedOrganization => Boolean(item));
}

function parseProject(item: Record<string, unknown>): ListedProject {
  const nested = item.organization && typeof item.organization === "object"
    ? item.organization as Record<string, unknown>
    : null;
  return {
    ref: asString(item.ref) || asString(item.id),
    name: asString(item.name),
    organizationId: asString(item.organization_id) || asString(nested?.id),
    organizationSlug: asString(item.organization_slug) || asString(nested?.slug),
  };
}

function mergeOrganizations(groups: ListedOrganization[][]): ListedOrganization[] {
  const merged = new Map<string, ListedOrganization>();
  const remember = (org: ListedOrganization) => {
    if (org.id) merged.set(org.id, org);
    if (org.slug) merged.set(org.slug, org);
  };
  for (const group of groups) {
    for (const org of group) {
      const prev = (org.id && merged.get(org.id)) || merged.get(org.slug);
      if (!prev) {
        remember(org);
        continue;
      }
      remember({
        id: prev.id || org.id,
        slug: prev.slug && prev.slug !== prev.id ? prev.slug : org.slug,
        name: prev.name && prev.name !== prev.slug ? prev.name : org.name,
      });
    }
  }
  return [...new Map([...merged.values()].map((org) => [org.id || org.slug, org])).values()];
}

function organizationsFromProjects(projects: ListedProject[]): ListedOrganization[] {
  return mergeOrganizations(projects.map((project) => {
    const slug = project.organizationSlug || project.organizationId;
    if (!slug) return [];
    return [{
      id: project.organizationId || slug,
      slug,
      name: project.organizationSlug || project.organizationId || slug,
    }];
  }));
}

async function listManagementProjects(token: string): Promise<ListedProject[]> {
  const response = await managementFetch(token, "/projects");
  if (!response.ok) return [];
  const data = await response.json().catch(() => null);
  const listed = asObjectArray(data)
    .map(parseProject)
    .filter((item) => cleanProjectRef(item.ref));
  const missingSlug = listed.filter((project) => !project.organizationSlug).slice(0, 8);
  if (missingSlug.length === 0) return listed;
  const details = await Promise.all(missingSlug.map(async (project) => {
    const detail = await managementFetch(token, `/projects/${project.ref}`);
    if (!detail.ok) return project;
    const body = await detail.json().catch(() => null);
    if (!body || typeof body !== "object") return project;
    const parsed = parseProject(body as Record<string, unknown>);
    return {
      ...project,
      name: project.name || parsed.name,
      organizationId: parsed.organizationId || project.organizationId,
      organizationSlug: parsed.organizationSlug || project.organizationSlug,
    };
  }));
  const byRef = new Map(details.map((project) => [project.ref, project]));
  return listed.map((project) => byRef.get(project.ref) || project);
}

async function findExistingPersonalCloud(token: string, organizationSlug = ""): Promise<string> {
  const named = (await listManagementProjects(token))
    .filter((project) => project.name === PERSONAL_CLOUD_PROJECT_NAME);
  const match = organizationSlug
    ? named.find((project) => (
      project.organizationSlug === organizationSlug
      || project.organizationId === organizationSlug
    ))
    : undefined;
  return match?.ref || (named.length === 1 ? named[0].ref : "") || (named[0]?.ref || "");
}

const NO_ORG_HELP = "该项目/令牌没有可用的组织。细粒度/Scoped 令牌经常读不到组织列表：请到 https://supabase.com/dashboard/account/tokens 用 Classic Tokens 再生成一把 sbp_。已经建过「AI Phone Personal Cloud」的不要删项目，用本页「已经部署过」填项目地址和 service_role。也可以打开组织页，把地址栏 supabase.com/dashboard/org/ 后面那段填进部署弹窗。";

async function handleOrganizations(token: string): Promise<NextResponse> {
  if (!token.startsWith("sbp_")) {
    return NextResponse.json({
      ok: false,
      error: "请粘贴账号 Access Token（以 sbp_ 开头）。项目 Settings → API 里的 service_role / anon / sb_secret 不能用来一键部署。已经建过个人云的不要删项目，用本页「已经部署过」填项目地址和 service_role key。",
    }, { status: 400 });
  }
  const [orgResponse, projects] = await Promise.all([
    managementFetch(token, "/organizations"),
    listManagementProjects(token),
  ]);
  const listedOrgs = orgResponse.ok ? parseOrganizations(await orgResponse.json().catch(() => null)) : [];
  const derivedOrgs = organizationsFromProjects(projects);
  const missingNames = derivedOrgs.filter((org) => org.name === org.slug || org.name === org.id).slice(0, 6);
  const fetchedOrgs = await Promise.all(missingNames.map(async (org) => {
    const response = await managementFetch(token, `/organizations/${encodeURIComponent(org.slug || org.id)}`);
    if (!response.ok) return org;
    return parseOrganizations(await response.json().catch(() => null))[0] || org;
  }));
  const organizations = mergeOrganizations([listedOrgs, derivedOrgs, fetchedOrgs]);
  const orgError = !orgResponse.ok
    ? await upstreamMessage(orgResponse)
    : organizations.length === 0
      ? NO_ORG_HELP
      : undefined;
  // 组织列表为空或无权限时，仍把项目列表和组织反推结果交给前端。
  return NextResponse.json({ ok: true, organizations, projects, orgError });
}

async function handleCreateProject(
  token: string,
  organizationSlug: string,
  regionCode: "americas" | "emea" | "apac",
): Promise<NextResponse> {
  const existing = await findExistingPersonalCloud(token, organizationSlug);
  if (existing) {
    return NextResponse.json({ ok: true, projectRef: existing, reused: true });
  }

  const projects = await listManagementProjects(token);
  const fromProject = projects.find((project) => (
    project.organizationSlug === organizationSlug
    || project.organizationId === organizationSlug
  ));
  const organizationId = isOrganizationId(organizationSlug)
    ? organizationSlug
    : fromProject?.organizationId || "";
  const slug = !isOrganizationId(organizationSlug)
    ? organizationSlug
    : fromProject?.organizationSlug || organizationSlug;

  // 只为创建请求生成一次，既不返回浏览器也不持久化。应用后续通过项目密钥工作，
  // 用户若需要直连数据库，可在自己的 Supabase Dashboard 中重设数据库密码。
  const dbPass = `${randomBytes(36).toString("base64url")}Aa1!`;
  const bodies: Array<Record<string, unknown>> = [
    {
      name: PERSONAL_CLOUD_PROJECT_NAME,
      organization_slug: slug,
      ...(organizationId ? { organization_id: organizationId } : {}),
      db_pass: dbPass,
      region_selection: { type: "smartGroup", code: regionCode },
    },
  ];
  if (organizationId && organizationId !== slug) {
    bodies.push({
      name: PERSONAL_CLOUD_PROJECT_NAME,
      organization_id: organizationId,
      db_pass: dbPass,
      region_selection: { type: "smartGroup", code: regionCode },
    });
  }

  let lastMessage = "";
  let lastStatus = 502;
  for (const body of bodies) {
    const response = await managementFetch(token, "/projects", {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (response.ok) {
      const data = await response.json() as { id?: unknown; ref?: unknown; status?: unknown };
      const projectRef = typeof data.ref === "string" ? data.ref : typeof data.id === "string" ? data.id : "";
      if (!cleanProjectRef(projectRef)) {
        return NextResponse.json({ ok: false, error: "Supabase 已创建项目，但没有返回有效的项目标识。" }, { status: 502 });
      }
      return NextResponse.json({
        ok: true,
        projectRef,
        status: typeof data.status === "string" ? data.status : "",
      });
    }
    lastStatus = response.status;
    lastMessage = await upstreamMessage(response);
  }
  const reused = await findExistingPersonalCloud(token, organizationSlug);
  if (reused) return NextResponse.json({ ok: true, projectRef: reused, reused: true });
  return NextResponse.json({
    ok: false,
    error: /organi[sz]ation/i.test(lastMessage)
      ? `${lastMessage} ${NO_ORG_HELP}`
      : lastMessage,
  }, { status: lastStatus });
}

async function handleProjectStatus(token: string, projectRef: string): Promise<NextResponse> {
  const response = await managementFetch(token, `/projects/${projectRef}`);
  if (!response.ok) {
    return NextResponse.json({ ok: false, error: await upstreamMessage(response) }, { status: response.status });
  }
  const data = await response.json() as { status?: unknown };
  return NextResponse.json({ ok: true, status: typeof data.status === "string" ? data.status : "" });
}

async function handleAssertDedicatedProject(token: string, projectRef: string): Promise<NextResponse> {
  const response = await managementFetch(token, `/projects/${projectRef}/database/query`, {
    method: "POST",
    body: JSON.stringify({
      query: `select case
        when to_regclass('public.ai_phone_cloud_meta') is not null then 'personal-cloud-safe-v2'
        when not exists (
          select 1 from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind in ('r', 'p')
            and c.relname <> all (array[
              'push_server_config', 'push_subscriptions', 'push_jobs', 'push_outbox',
              'push_shortcut_commands', 'push_bridge_config', 'push_bridge_snapshots',
              'push_screen_sessions', 'push_screen_threads'
            ])
        ) then 'personal-cloud-safe-v2'
        else 'shared-project-blocked'
      end as deployment_guard`,
      read_only: true,
    }),
  });
  if (!response.ok) {
    return NextResponse.json({ ok: false, error: await upstreamMessage(response) }, { status: response.status });
  }
  const rows = await response.json().catch(() => null) as Array<{ deployment_guard?: unknown }> | null;
  const guard = Array.isArray(rows) && typeof rows[0]?.deployment_guard === "string"
    ? rows[0].deployment_guard
    : "";
  if (guard === "shared-project-blocked") {
    return NextResponse.json(
      { ok: false, error: "检测到该项目包含其他业务表，已中止个人云部署。请使用新建的独立 Supabase 项目。" },
      { status: 409 },
    );
  }
  if (guard !== "personal-cloud-safe-v2") {
    return NextResponse.json({ ok: false, error: "无法确认目标项目为独立个人云，已中止部署。" }, { status: 502 });
  }
  return NextResponse.json({ ok: true });
}

function revealedKey(row: Record<string, unknown>): string {
  return asString(row.api_key) || asString(row.key) || asString(row.secret) || asString(row.value);
}

async function handleApiKeys(token: string, projectRef: string): Promise<NextResponse> {
  const response = await managementFetch(token, `/projects/${projectRef}/api-keys?reveal=true`);
  if (!response.ok) {
    return NextResponse.json({
      ok: false,
      error: `${await upstreamMessage(response)}。读不到密钥时，请到 Dashboard → Project Settings → API 复制 service_role，用本页「已经部署过」填上。细粒度令牌需要勾选 api_gateway_keys_read。`,
    }, { status: response.status });
  }
  const rows = asObjectArray(await response.json().catch(() => null));
  const pick = (predicate: (row: Record<string, unknown>) => boolean): string => {
    const row = rows.find((item) => predicate(item) && revealedKey(item));
    return row ? revealedKey(row) : "";
  };
  // 旧版项目返回 name=service_role 的 JWT key；新版密钥体系是 type=secret 的 sb_secret_ key。
  const serviceRoleKey = pick((row) => asString(row.name) === "service_role")
    || pick((row) => asString(row.type) === "secret")
    || pick((row) => asString(row.type) === "legacy" && /service/i.test(asString(row.name)));
  if (!serviceRoleKey) {
    return NextResponse.json(
      {
        ok: false,
        error: "该项目没有可用的 service_role/secret key。请到 Dashboard → Project Settings → API 复制，用本页「已经部署过」手动接上。不要删掉「AI Phone Personal Cloud」。细粒度令牌还要勾选 api_gateway_keys_read。",
      },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true, serviceRoleKey });
}

async function handleRunSql(token: string, projectRef: string, sql: string): Promise<NextResponse> {
  const response = await managementFetch(token, `/projects/${projectRef}/database/query`, {
    method: "POST",
    body: JSON.stringify({ query: sql, read_only: false }),
  });
  if (!response.ok) {
    return NextResponse.json({ ok: false, error: await upstreamMessage(response) }, { status: response.status });
  }
  return NextResponse.json({ ok: true });
}

export async function POST(request: Request): Promise<NextResponse> {
  let payload: AdminPayload;
  try {
    payload = await request.json() as AdminPayload;
  } catch {
    return NextResponse.json({ ok: false, error: "请求体不是合法 JSON。" }, { status: 400 });
  }

  const token = cleanToken(payload.token);
  if (!token) return NextResponse.json({ ok: false, error: "缺少 Access Token。" }, { status: 400 });

  try {
    if (payload.action === "organizations") return await handleOrganizations(token);
    if (payload.action === "create_project") {
      const organizationSlug = cleanOrganizationSlug(payload.organizationSlug);
      if (!organizationSlug) {
        const reused = await findExistingPersonalCloud(token);
        if (reused) return NextResponse.json({ ok: true, projectRef: reused, reused: true });
        return NextResponse.json({ ok: false, error: NO_ORG_HELP }, { status: 400 });
      }
      return await handleCreateProject(token, organizationSlug, cleanRegionCode(payload.regionCode));
    }

    const projectRef = cleanProjectRef(payload.projectRef);
    if (!projectRef) return NextResponse.json({ ok: false, error: "项目标识不合法。" }, { status: 400 });

    if (payload.action === "project_status") return await handleProjectStatus(token, projectRef);
    if (payload.action === "assert_dedicated_project") return await handleAssertDedicatedProject(token, projectRef);
    if (payload.action === "api_keys") return await handleApiKeys(token, projectRef);
    if (payload.action === "run_sql") {
      const sql = typeof payload.sql === "string" ? payload.sql : "";
      if (!sql.trim()) return NextResponse.json({ ok: false, error: "缺少要执行的 SQL。" }, { status: 400 });
      if (sql.length > 100_000) return NextResponse.json({ ok: false, error: "SQL 过长。" }, { status: 400 });
      return await handleRunSql(token, projectRef, sql);
    }
    return NextResponse.json({ ok: false, error: "未知操作。" }, { status: 400 });
  } catch {
    return NextResponse.json({ ok: false, error: "暂时无法连接 Supabase 管理接口。" }, { status: 502 });
  }
}
