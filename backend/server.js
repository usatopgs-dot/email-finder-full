import express from "express";
import dns from "dns/promises";
import fetch from "node-fetch";
import * as cheerio from "cheerio";

const app = express();
app.use(express.json({ limit: "2mb" }));

// Simple CORS (so Netlify can call Render)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const API_KEY = process.env.GOOGLE_MAPS_API_KEY;

app.get("/", (req, res) => {
  res.send("Email Finder FULL API running");
});

function uniq(arr) {
  return [...new Set((arr || []).filter(Boolean))];
}

function extractEmailsFromText(text) {
  const emails = [];
  const re = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const matches = text.match(re) || [];
  for (const m of matches) emails.push(m.toLowerCase());
  return uniq(emails);
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    return res;
  } finally {
    clearTimeout(t);
  }
}

async function scrapeEmailsFromWebsite(websiteUrl) {
  try {
    const res = await fetchWithTimeout(websiteUrl, {
      headers: { "User-Agent": "Mozilla/5.0 EmailFinderBot" }
    }, 15000);

    const html = await res.text();
    const $ = cheerio.load(html);

    // 1) mailto links
    const mailtos = [];
    $("a[href^='mailto:']").each((_, el) => {
      const href = $(el).attr("href") || "";
      const email = href.replace("mailto:", "").split("?")[0].trim().toLowerCase();
      if (email) mailtos.push(email);
    });

    // 2) plain emails on page
    const plain = extractEmailsFromText(html);

    // 3) Try common contact pages quickly (optional light)
    const candidates = uniq(
      $("a").map((_, el) => ($(el).attr("href") || "")).get()
    ).filter(h => /contact|about|support/i.test(h));

    const extra = [];
    for (const href of candidates.slice(0, 2)) {
      try {
        const u = new URL(href, websiteUrl).toString();
        const r2 = await fetchWithTimeout(u, { headers: { "User-Agent": "Mozilla/5.0 EmailFinderBot" } }, 12000);
        const h2 = await r2.text();
        extra.push(...extractEmailsFromText(h2));
      } catch {}
    }

    return uniq([...mailtos, ...plain, ...extra]).slice(0, 50);
  } catch {
    return [];
  }
}

const DISPOSABLE = new Set([
  "mailinator.com","10minutemail.com","guerrillamail.com","tempmail.com","yopmail.com",
  "getnada.com","trashmail.com","mintemail.com","fakeinbox.com"
]);

async function mxOk(email) {
  try {
    const domain = email.split("@")[1]?.toLowerCase();
    if (!domain) return false;
    if (DISPOSABLE.has(domain)) return false;
    const mx = await dns.resolveMx(domain);
    return Array.isArray(mx) && mx.length > 0;
  } catch {
    return false;
  }
}

async function placesSearchText(query, maxResults = 20) {
  if (!API_KEY) throw new Error("Missing GOOGLE_MAPS_API_KEY in Render env vars.");

  const url = "https://places.googleapis.com/v1/places:searchText";
  const body = {
    textQuery: query,
    maxResultCount: Math.min(Math.max(Number(maxResults || 20), 1), 100)
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": API_KEY,
      "X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.rating,places.nationalPhoneNumber,places.websiteUri"
    },
    body: JSON.stringify(body)
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(JSON.stringify(data));
  }

  const places = (data.places || []).map(p => ({
    name: p?.displayName?.text || "",
    address: p?.formattedAddress || "",
    rating: p?.rating ?? "",
    phone: p?.nationalPhoneNumber || "",
    website: p?.websiteUri || ""
  }));

  return places;
}

// Main runner
app.post("/api/run", async (req, res) => {
  try {
    const { mode, items, maxResults, verify } = req.body || {};
    const lines = Array.isArray(items) ? items : [];

    if (lines.length === 0) return res.status(400).json({ error: "No items provided." });

    const rows = [];

    if (mode === "websites") {
      for (const site of lines.slice(0, 100)) {
        const website = site.trim();
        const emails = await scrapeEmailsFromWebsite(website);
        let verifiedEmails = [];
        if (verify) {
          const checks = await Promise.all(emails.map(async e => (await mxOk(e)) ? e : null));
          verifiedEmails = uniq(checks);
        }
        rows.push({
          name: "",
          phone: "",
          website,
          address: "",
          rating: "",
          emails,
          verifiedEmails
        });
      }
    } else {
      // places
      for (const q of lines.slice(0, 20)) {
        const places = await placesSearchText(q, maxResults || 20);

        // small concurrency to avoid crashes
        for (const p of places) {
          const emails = p.website ? await scrapeEmailsFromWebsite(p.website) : [];
          let verifiedEmails = [];
          if (verify) {
            const checks = await Promise.all(emails.map(async e => (await mxOk(e)) ? e : null));
            verifiedEmails = uniq(checks);
          }
          rows.push({
            name: p.name,
            phone: p.phone,
            website: p.website,
            address: p.address,
            rating: p.rating,
            emails,
            verifiedEmails
          });
        }
      }
    }

    res.json({ rows });
  } catch (err) {
    res.status(500).send(err?.message || String(err));
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on " + PORT));
