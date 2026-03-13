import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  try {
    const { email, code } = await req.json();
    if (!email || !code) {
      return new Response(
        JSON.stringify({ error: "E-posta ve kod gerekli" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );
    const { data: row } = await supabaseAdmin
      .from("otp_codes")
      .select("code")
      .eq("email", email.toLowerCase())
      .gt("expires_at", new Date().toISOString())
      .single();
    if (!row || row.code !== String(code).trim()) {
      return new Response(
        JSON.stringify({ error: "Geçersiz veya süresi dolmuş kod" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    await supabaseAdmin.from("otp_codes").delete().eq("email", email.toLowerCase());

    const tempPass = crypto.randomUUID().replace(/-/g, "").slice(0, 16) + "Aa1!";
    const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email: email.toLowerCase(),
      password: tempPass,
      email_confirm: true,
    });
    let session = null;
    if (createErr) {
      if (createErr.message?.includes("already") || createErr.message?.includes("exists")) {
        const { data: { users } } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 });
        const u = users?.find((x) => x.email?.toLowerCase() === email.toLowerCase());
        if (u) {
          await supabaseAdmin.auth.admin.updateUserById(u.id, { password: tempPass });
        }
      } else {
        return new Response(
          JSON.stringify({ error: createErr.message }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }
    const { data: signIn, error: signErr } = await supabaseAdmin.auth.signInWithPassword({
      email: email.toLowerCase(),
      password: tempPass,
    });
    if (signErr) {
      return new Response(
        JSON.stringify({ error: "Oturum açılamadı: " + signErr.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    session = signIn.session;

    if (!session) {
      return new Response(
        JSON.stringify({ error: "Oturum oluşturulamadı" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        expires_in: session.expires_in,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ error: String(e) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
