import express from "express";
import * as cheerio from "cheerio";
import dns from "dns/promises";
import fetch from "node-fetch";


const app = express();
app.use(express.json({ limit: "2mb" }));

// CORS
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

const DISPOSABLE = new Set([
  "mailinator.com",
  "tempmail.com",
  "10minutemail.com",
  "guerrillamail.com",
  "yopmail.com"
]);

function cleanEmails(arr) {
  return [...new Set(arr.map(e => e.toLowerCase()))];
}

async function hasMx(domain) {
  try {
    const r = await dns.resolveMx(domain);
    return r && r.length > 0;
  } catch {
    return false;
  }
}

async function verifyEmail(email) {
  const domain = email.split("@")[1];
  if (!domain) return false;
  if (DISPOSABLE.has(domain)) return false;
  return await hasMx(domain);
}

async function fetchHTML(url) {
  try {
    const r = await fetch(url, { headers:{ "user-agent":"Mozilla/5.0"} });
    if(!r.ok) return "";
    return await r.text();
  } catch {
    return "";
  }
}

async function scrapeWebsiteEmails(site) {
  if(!site) return [];

  let url = site;
  if(!/^https?:\/\//i.test(url)) url = "https://" + url;

  const html = await fetchHTML(url);
  if(!html) return [];

  const found = html.match(EMAIL_REGEX) || [];

  const $ = cheerio.load(html);
  const links = [];

  $("a[href]").each((i,a)=>{
    const h = $(a).attr("href") || "";
    if(h.includes("contact") || h.includes("about")){
      try{
        links.push(new URL(h, url).toString());
      }catch{}
    }
  });

  for(const l of links.slice(0,3)){
    const h = await fetchHTML(l);
    if(h){
      const m = h.match(EMAIL_REGEX) || [];
      found.push(...m);
    }
  }

  return cleanEmails(found);
}

// -------- Google Places (NEW API) ----------
async function placesSearch(textQuery, maxResults) {

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;

  const res = await fetch(
    "https://places.googleapis.com/v1/places:searchText",
    {
      method:"POST",
      headers:{
        "Content-Type":"application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask":
          "places.displayName,places.formattedAddress,places.rating,places.websiteUri,places.internationalPhoneNumber"
      },
      body: JSON.stringify({
        textQuery,
        maxResultCount: maxResults
      })
    }
  );

  const data = await res.json();
  return data.places || [];
}

// -------- API --------

app.post("/api/places-to-csv", async (req, res) => {

  const { textQuery, maxResults = 20, verifyEmails = false } = req.body;

  if(!process.env.GOOGLE_MAPS_API_KEY){
    return res.status(400).json({ error:"Missing GOOGLE_MAPS_API_KEY" });
  }

  if(!textQuery){
    return res.status(400).json({ error:"textQuery required" });
  }

  const places = await placesSearch(textQuery, maxResults);

  const rows = [];

  for(const p of places){

    const name = p.displayName?.text || "";
    const phone = p.internationalPhoneNumber || "";
    const website = p.websiteUri || "";
    const address = p.formattedAddress || "";
    const rating = p.rating || "";

    let emails = [];
    let verified = [];

    if(website){
      emails = await scrapeWebsiteEmails(website);

      if(verifyEmails){
        for(const e of emails){
          if(await verifyEmail(e)) verified.push(e);
        }
      }
    }

    rows.push({
      businessName: name,
      phone,
      website,
      address,
      rating,
      foundEmails: emails,
      verifiedEmails: verified
    });
  }

  const header = [
    "Business Name",
    "Phone",
    "Website",
    "Address",
    "Rating",
    "Emails",
    "Verified Emails"
  ];

  const csvLines = [
    header.join(","),
    ...rows.map(r => [
      `"${r.businessName.replace(/"/g,'""')}"`,
      `"${r.phone}"`,
      `"${r.website}"`,
      `"${r.address.replace(/"/g,'""')}"`,
      `"${r.rating}"`,
      `"${r.foundEmails.join(" | ")}"`,
      `"${r.verifiedEmails.join(" | ")}"`
    ].join(","))
  ];

  res.json({
    count: rows.length,
    rows,
    csv: csvLines.join("\n")
  });

});

app.get("/", (req,res)=>{
  res.send("Email Finder FULL API running");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on " + PORT);
});
