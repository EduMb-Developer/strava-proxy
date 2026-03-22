// api/strava.js — Strava OAuth proxy para ChemaAI
// Variables de entorno necesarias en Vercel:
// STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const CLIENT_ID     = process.env.STRAVA_CLIENT_ID;
  const CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;
  const { action, code, refresh_token } = req.query;

  // ── 1. Redirect to Strava OAuth ──────────────────────────────────────────
  if (action === "auth") {
    const redirect = `https://www.strava.com/oauth/authorize?client_id=${CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(req.headers.host ? "https://" + req.headers.host + "/api/strava?action=callback" : "")}&approval_prompt=auto&scope=activity:read_all`;
    return res.redirect(302, redirect);
  }

  // ── 2. OAuth Callback — exchange code for tokens ─────────────────────────
  if (action === "callback" && code) {
    try {
      const r = await fetch("https://www.strava.com/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code, grant_type: "authorization_code" }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.message || "Token error");
      // Return tokens as HTML so user can copy them
      return res.status(200).send(`
        <html><body style="font-family:monospace;background:#0a0a0a;color:#e8ff00;padding:30px">
        <h2>✅ Strava conectado</h2>
        <p>Copia estos valores y pégalos en Vercel → Settings → Environment Variables:</p>
        <p><b>STRAVA_REFRESH_TOKEN</b><br>
        <input style="width:100%;padding:8px;background:#111;color:#e8ff00;border:1px solid #e8ff00;font-size:12px" 
          value="${data.refresh_token}" readonly onclick="this.select()"></p>
        <p style="color:#888">Después de añadir la variable, haz Redeploy en Vercel.</p>
        </body></html>
      `);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── 3. Refresh token & get activities ────────────────────────────────────
  const storedRefresh = process.env.STRAVA_REFRESH_TOKEN || refresh_token;
  if (!storedRefresh) {
    return res.status(400).json({
      error: "No hay refresh_token. Autoriza primero en /api/strava?action=auth",
      auth_url: "/api/strava?action=auth"
    });
  }

  try {
    // Refresh access token
    const tokenRes = await fetch("https://www.strava.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: storedRefresh, grant_type: "refresh_token" }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) throw new Error(tokenData.message || "Refresh failed");

    const accessToken = tokenData.access_token;

    // Get activities (last 90 days)
    const before = Math.floor(Date.now() / 1000);
    const after  = before - 90 * 24 * 60 * 60;
    const actRes = await fetch(`https://www.strava.com/api/v3/athlete/activities?before=${before}&after=${after}&per_page=100`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const activities = await actRes.json();
    if (!actRes.ok) throw new Error(activities.message || "Activities fetch failed");

    const bikeTypes = ["Ride", "VirtualRide", "GravelRide", "MountainBikeRide", "EBikeRide"];
    const result = activities
      .filter(a => bikeTypes.includes(a.type))
      .map(a => {
        const durH      = (a.moving_time || 0) / 3600;
        const hrAvg     = a.average_heartrate || 0;
        const intensity = hrAvg > 0 ? Math.min(hrAvg / 170, 1.2) : 0.65;
        const load      = Math.round(durH * intensity * 100);
        return {
          date:     a.start_date_local?.slice(0, 10) || "",
          name:     a.name || "Cycling",
          type:     a.type,
          duration: Math.round((a.moving_time || 0) / 60),
          distance: +((a.distance || 0) / 1000).toFixed(1),
          hrAvg:    Math.round(hrAvg),
          load,
        };
      });

    return res.status(200).json(result);

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
