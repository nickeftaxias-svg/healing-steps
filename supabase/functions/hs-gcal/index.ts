// Healing Steps → Google Calendar (κοινό ημερολόγιο ιατρείου μέσω service account)
// Actions: status | sync {sessions[], clients[]} | full
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const APP_URL = "https://healing-steps.vercel.app";
const TZ = "Europe/Athens";

type SA = { client_email: string; private_key: string };
function sa(): SA | null {
  const raw = Deno.env.get("GOOGLE_SA_JSON");
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
const b64url = (b: ArrayBuffer | string) => {
  const s = typeof b === "string"
    ? btoa(String.fromCharCode(...new TextEncoder().encode(b)))
    : btoa(String.fromCharCode(...new Uint8Array(b)));
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

let tok: { t: string; exp: number } | null = null;
async function gtoken(): Promise<string> {
  if (tok && tok.exp > Date.now() + 60_000) return tok.t;
  const k = sa();
  if (!k) throw new Error("missing_sa");
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({
    iss: k.client_email, scope: "https://www.googleapis.com/auth/calendar",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  }));
  const pem = k.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(head + "." + claim));
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claim}.${b64url(sig)}` }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error("google_token: " + (j.error_description || j.error));
  tok = { t: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return tok.t;
}
async function g(method: string, path: string, body?: unknown) {
  const t = await gtoken();
  const r = await fetch("https://www.googleapis.com/calendar/v3" + path, {
    method, headers: { Authorization: "Bearer " + t, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  let j: any = null;
  try { j = await r.json(); } catch { /* 204 */ }
  return { status: r.status, j };
}
async function eventId(practice: string, session: string) {
  const h = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(practice + "|" + session));
  return "hs" + [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function addMin(date: string, time: string, min: number) {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = (time || "09:00").split(":").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d, hh, mm + min));
  const p = (n: number) => String(n).padStart(2, "0");
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}T${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:00`;
}
function buildEvent(s: any, c: any) {
  const isAct = s.kind === "activity";
  const name = c ? `${c.first || ""} ${c.last || ""}`.trim() : "Πελάτης";
  const pre = s.status === "done" ? "✓ " : s.status === "noshow" ? "✕ Δεν ήρθε · " : "";
  const loc = isAct ? (s.addr || "") : s.type === "home" ? (c?.addr || "") : s.type === "online" ? "Online" : "Γραφείο";
  const desc = [
    isAct ? (s.note || "") : `${s.type === "home" ? "Κατ' οίκον" : s.type === "online" ? "Online" : "Γραφείο"} · ${s.dur || 50}′`,
    !isAct && c?.floor ? `Όροφος/κουδούνι: ${c.floor}` : "",
    !isAct && c?.access ? `Πρόσβαση: ${c.access}` : "",
    !isAct && c?.phone ? `Τηλ: ${c.phone}` : "",
    "", `Healing Steps: ${APP_URL}`,
  ].filter((x, i, a) => x !== "" || (i > 0 && a[i - 1] !== "")).join("\n");
  const ev: any = {
    summary: isAct ? `📌 ${s.title || "Δραστηριότητα"}` : pre + name,
    location: loc, description: desc,
    start: { dateTime: addMin(s.date, s.time, 0), timeZone: TZ },
    end: { dateTime: addMin(s.date, s.time, +s.dur || (isAct ? 30 : 50)), timeZone: TZ },
    status: "confirmed",
    reminders: { useDefault: true },
    extendedProperties: { private: { hs_session: String(s.id) } },
  };
  if (s.status === "done") ev.colorId = "10";
  else if (s.status === "noshow") ev.colorId = "11";
  else if (isAct) ev.colorId = "8";
  return ev;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action || "sync";
    const practice = String(body.practice_id || "");
    if (!practice) return json({ ok: false, error: "missing_practice" }, 400);

    const userClient = createClient(SB_URL, ANON, { global: { headers: { Authorization: req.headers.get("Authorization") || "" } } });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ ok: false, error: "not_authenticated" }, 401);
    const admin = createClient(SB_URL, SRK, { auth: { persistSession: false } });
    const { data: mem } = await admin.from("hs_members").select("role").eq("practice_id", practice).eq("user_id", user.id).maybeSingle();
    if (!mem) return json({ ok: false, error: "not_member" }, 403);
    const { data: pr } = await admin.from("hs_practices").select("id,gcal_id").eq("id", practice).maybeSingle();
    const k = sa();
    const cal = pr?.gcal_id || "";
    const setErr = (e: string | null) =>
      admin.from("hs_practices").update({ gcal_error: e, gcal_checked_at: new Date().toISOString() }).eq("id", practice);

    if (action === "status") {
      if (!k) return json({ ok: false, error: "missing_sa" });
      if (!cal) return json({ ok: false, error: "no_calendar", sa_email: k.client_email });
      const r = await g("GET", `/calendars/${encodeURIComponent(cal)}`);
      if (r.status !== 200) {
        const e = r.status === 404 ? "calendar_not_shared" : (r.j?.error?.message || "google_" + r.status);
        await setErr(e);
        return json({ ok: false, error: e, sa_email: k.client_email });
      }
      const acl = await g("GET", `/users/me/calendarList/${encodeURIComponent(cal)}`);
      const role = acl.j?.accessRole || "";
      const canWrite = ["writer", "owner"].includes(role);
      await setErr(canWrite ? null : "read_only");
      return json({ ok: canWrite, error: canWrite ? null : "read_only", sa_email: k.client_email, summary: r.j.summary, role });
    }

    if (!k) return json({ ok: false, error: "missing_sa" });
    if (!cal) return json({ ok: false, error: "no_calendar" });

    // ποιες συνεδρίες
    let q = admin.from("hs_records").select("id,data,deleted").eq("practice_id", practice).eq("kind", "sessions");
    const today = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
    const sIds: string[] = (body.sessions || []).map(String).slice(0, 500);
    const cIds: string[] = (body.clients || []).map(String).slice(0, 100);
    let rows: any[] = [];
    if (action === "full") {
      const { data } = await q.gte("data->>date", today).limit(2000);
      rows = data || [];
    } else {
      if (sIds.length) { const { data } = await q.in("id", sIds); rows = rows.concat(data || []); }
      if (cIds.length) {
        const { data } = await admin.from("hs_records").select("id,data,deleted").eq("practice_id", practice).eq("kind", "sessions")
          .in("data->>clientId", cIds).gte("data->>date", today).limit(1000);
        rows = rows.concat(data || []);
      }
      // διαγραμμένες εγγραφές που δεν υπάρχουν πια ως γραμμή
      const seen = new Set(rows.map((r) => r.id));
      sIds.filter((id) => !seen.has(id)).forEach((id) => rows.push({ id, data: null, deleted: true }));
    }
    const uniq = new Map<string, any>(); rows.forEach((r) => uniq.set(r.id, r)); rows = [...uniq.values()];
    const clientIds = [...new Set(rows.map((r) => r.data?.clientId).filter(Boolean))];
    const clients = new Map<string, any>();
    if (clientIds.length) {
      const { data } = await admin.from("hs_records").select("id,data").eq("practice_id", practice).eq("kind", "clients").in("id", clientIds);
      (data || []).forEach((c) => clients.set(c.id, c.data));
    }

    let up = 0, del = 0; const errors: string[] = [];
    const calP = encodeURIComponent(cal);
    const work = rows.map((r) => async () => {
      const s = r.data, eid = await eventId(practice, r.id);
      try {
        if (r.deleted || !s || s.status === "cancel" || !s.date) {
          const d = await g("DELETE", `/calendars/${calP}/events/${eid}`);
          if ([200, 204].includes(d.status)) del++;
          else if (![404, 410].includes(d.status)) errors.push(d.j?.error?.message || "delete_" + d.status);
          return;
        }
        const ev = buildEvent(s, clients.get(s.clientId));
        let u = await g("PUT", `/calendars/${calP}/events/${eid}`, ev);
        if (u.status === 404) u = await g("POST", `/calendars/${calP}/events`, { ...ev, id: eid });
        if (u.status === 200) up++; else errors.push(u.j?.error?.message || "put_" + u.status);
      } catch (e) { errors.push(String((e as Error).message || e)); }
    });
    for (let i = 0; i < work.length; i += 4) await Promise.all(work.slice(i, i + 4).map((f) => f()));
    await setErr(errors[0] || null);
    return json({ ok: errors.length === 0, upserted: up, deleted: del, errors: errors.slice(0, 5) });
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message || e) }, 500);
  }
});
