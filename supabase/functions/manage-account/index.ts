import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type Role = "owner" | "court_owner" | "staff" | "host";

type Payload = {
  action?: "create" | "update" | "delete";
  id?: string;
  fullName?: string;
  username?: string;
  email?: string;
  password?: string;
  role?: Role;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const roles = new Set<Role>(["owner", "court_owner", "staff", "host"]);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function errMsg(err: unknown) {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    const maybe = err as Record<string, unknown>;
    if (typeof maybe.message === "string") return maybe.message;
    if (typeof maybe.error === "string") return maybe.error;
  }
  return String(err || "Unknown error");
}

function cleanText(value: unknown) {
  return String(value || "").trim();
}

async function requireOwner(req: Request, db: ReturnType<typeof createClient>) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return { error: json({ error: "Unauthorized" }, 401) };

  const { data: userData, error: userErr } = await db.auth.getUser(token);
  if (userErr || !userData?.user) return { error: json({ error: "Unauthorized" }, 401) };

  const { data: account, error: accountErr } = await db
    .from("accounts")
    .select("id, role")
    .eq("id", userData.user.id)
    .single();

  if (accountErr || account?.role !== "owner") {
    return { error: json({ error: "Only system owner can manage accounts" }, 403) };
  }

  return { user: userData.user };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceRoleKey =
    Deno.env.get("SERVICE_ROLE_KEY") ||
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
    "";

  if (!supabaseUrl || !serviceRoleKey) return json({ error: "Supabase service credentials are missing" }, 500);

  const db = createClient(supabaseUrl, serviceRoleKey);
  const ownerResult = await requireOwner(req, db);
  if ("error" in ownerResult) return ownerResult.error;
  const ownerUser = ownerResult.user;

  let body: Payload;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const action = body.action;
  const id = cleanText(body.id);
  const fullName = cleanText(body.fullName);
  const username = cleanText(body.username);
  const email = cleanText(body.email).toLowerCase();
  const password = String(body.password || "");
  const role = roles.has(body.role as Role) ? body.role as Role : "staff";

  try {
    if (action === "create") {
      if (!fullName || !username || !email || !password) {
        return json({ error: "Full name, username, email, and password are required" }, 400);
      }

      const { data: usernameMatch } = await db.from("accounts").select("id").eq("username", username).limit(1);
      const { data: emailMatch } = await db.from("accounts").select("id").eq("email", email).limit(1);
      if ((usernameMatch && usernameMatch.length > 0) || (emailMatch && emailMatch.length > 0)) {
        return json({ error: "Username or email already exists" }, 409);
      }

      const { data: authData, error: authErr } = await db.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name: fullName, username, role },
      });
      if (authErr || !authData?.user) throw authErr || new Error("Auth user was not created");

      const account = {
        id: authData.user.id,
        username,
        full_name: fullName,
        email,
        role,
        created_at: new Date().toISOString(),
      };

      const { error: profileErr } = await db.from("accounts").upsert(account);
      if (profileErr) {
        await db.auth.admin.deleteUser(authData.user.id).catch(() => {});
        throw profileErr;
      }

      return json({ ok: true, account });
    }

    if (action === "update") {
      if (!id || !fullName || !username || !email) {
        return json({ error: "Account id, full name, username, and email are required" }, 400);
      }
      if (id === ownerUser.id && role !== "owner") {
        return json({ error: "You cannot remove your own owner role" }, 400);
      }

      const { data: usernameMatch } = await db.from("accounts").select("id").eq("username", username).neq("id", id).limit(1);
      const { data: emailMatch } = await db.from("accounts").select("id").eq("email", email).neq("id", id).limit(1);
      if ((usernameMatch && usernameMatch.length > 0) || (emailMatch && emailMatch.length > 0)) {
        return json({ error: "Username or email already exists" }, 409);
      }

      const authUpdate: Record<string, unknown> = {
        email,
        user_metadata: { full_name: fullName, username, role },
      };
      if (password) authUpdate.password = password;

      const { error: authErr } = await db.auth.admin.updateUserById(id, authUpdate);
      if (authErr) throw authErr;

      const { data: account, error: profileErr } = await db
        .from("accounts")
        .update({ username, full_name: fullName, email, role })
        .eq("id", id)
        .select("*")
        .single();
      if (profileErr) throw profileErr;

      return json({ ok: true, account });
    }

    if (action === "delete") {
      if (!id) return json({ error: "Account id is required" }, 400);
      if (id === ownerUser.id) return json({ error: "You cannot delete your own account" }, 400);

      const { error: authErr } = await db.auth.admin.deleteUser(id);
      if (authErr) throw authErr;

      const { error: profileErr } = await db.from("accounts").delete().eq("id", id);
      if (profileErr) throw profileErr;

      return json({ ok: true });
    }

    return json({ error: "Unknown account action" }, 400);
  } catch (err) {
    return json({ error: errMsg(err) }, 500);
  }
});
