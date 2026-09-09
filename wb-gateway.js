const http = require("http");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

const PORT = 8787;
const HOST = "127.0.0.1";
const BASE = "https://www.workbuddy.ai";
const DIR = __dirname;
const ACCOUNTS_FILE = path.join(DIR, "accounts.json");
const TOKEN_FILE = path.join(DIR, "wb-token.json");
const INDEX_FILE = path.join(DIR, "index.html");
const UA = "WorkBuddy/5.3.11 WorkBuddy/5.3.11 CLI/2.115.0";
const DEFAULT_SYSTEM = "You are a helpful assistant.";
const COOLDOWN_MS = 12 * 60 * 60 * 1000;
const QUOTA_ERR_CODES = [4006];

const MODELS = [
  "default-model", "fast-model", "balanced-model", "primary-model", "deep-model",
  "hy4-preview", "hy3", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna",
  "gpt-5.5", "gpt-5.4", "gpt-5.3-codex", "gemini-3.5-flash",
  "glm-5.3", "glm-5.2", "kimi-k3", "kimi-k2.6", "minimax-m3",
];

// Local aliases -> real upstream model id.
// Needed because opencode's builtin model catalog hardcodes capabilities for
// some ids (e.g. hy4-preview is marked text-only there, which blocks image
// attachments). A non-colliding alias lets local config define modalities.
const MODEL_ALIAS = {
  "hy4-preview-local": "hy4-preview",
  "hy4-vision": "hy4-preview",
  "hy3-local": "hy3",
  "hy3-vision": "hy3",
};
const resolveModel = (m) => MODEL_ALIAS[m] || m;

function loadAccounts() {
  if (fs.existsSync(ACCOUNTS_FILE)) {
    try { return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf8")); } catch { return []; }
  }
  if (fs.existsSync(TOKEN_FILE)) {
    try {
      const t = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
      if (t.accessToken) return [{ name: "default", accessToken: t.accessToken, refreshToken: t.refreshToken || "", userId: t.userId || "" }];
    } catch {}
  }
  return [];
}
function saveAccounts(a) { fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(a, null, 1)); }

const cooldown = new Map();
const banned = () => Date.now() + COOLDOWN_MS;
const isCooling = (name) => (cooldown.get(name) || 0) > Date.now();
const coolLeft = (name) => Math.max(0, (cooldown.get(name) || 0) - Date.now());

function pickAccount() {
  const accounts = loadAccounts();
  const ready = accounts.find((a) => !isCooling(a.name));
  if (ready) return { acc: ready, allBusy: false };
  const soonest = accounts
    .slice()
    .sort((a, b) => coolLeft(a.name) - coolLeft(b.name))[0];
  return { acc: soonest || null, allBusy: true };
}

function jwtPayload(token) {
  try { return JSON.parse(Buffer.from(token.split(".")[1], "base64").toString("utf8")); } catch { return {}; }
}

function wbHeaders(acc) {
  return {
    "Accept": "application/json",
    "Content-Type": "application/json",
    "Authorization": "Bearer " + acc.accessToken,
    "X-User-Id": acc.userId || jwtPayload(acc.accessToken).sub || "",
    "X-Domain": "www.workbuddy.ai",
    "X-Product": "SaaS",
    "User-Agent": UA,
  };
}

function json(res, code, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(b) });
  res.end(b);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function fixSystemOrder(messages) {
  const idx = messages.findIndex((m) => m.role === "system");
  if (idx === -1) {
    messages.unshift({ role: "system", content: DEFAULT_SYSTEM });
  } else if (idx > 0) {
    const m = messages.splice(idx, 1)[0];
    messages.unshift(m);
  }
}

function collectSSE(txt) {
  let content = "", reasoning = "";
  const tools = {};
  let finish = null, usage = null, id = null, model = null, created = 0;
  for (const line of txt.split("\n")) {
    const s = line.trim();
    if (!s.startsWith("data:")) continue;
    const p = s.slice(5).trim();
    if (p === "[DONE]") break;
    let j;
    try { j = JSON.parse(p); } catch { continue; }
    if (j.id) id = j.id;
    if (j.model) model = j.model;
    if (j.created) created = j.created;
    if (j.usage) usage = j.usage;
    for (const ch of j.choices || []) {
      const d = ch.delta || {};
      if (d.content) content += d.content;
      if (d.reasoning_content) reasoning += d.reasoning_content;
      for (const tc of d.tool_calls || []) {
        const i = tc.index || 0;
        if (!tools[i]) tools[i] = { id: "", type: "function", function: { name: "", arguments: "" } };
        if (tc.id) tools[i].id = tc.id;
        if (tc.function && tc.function.name) tools[i].function.name += tc.function.name;
        if (tc.function && tc.function.arguments) tools[i].function.arguments += tc.function.arguments;
      }
      if (ch.finish_reason) finish = ch.finish_reason;
    }
  }
  const message = { role: "assistant", content: content };
  if (reasoning) message.reasoning_content = reasoning;
  const tcList = Object.keys(tools).sort((a, b) => a - b).map((k) => tools[k]);
  if (tcList.length) message.tool_calls = tcList;
  return {
    id: id || "chatcmpl-wb",
    object: "chat.completion",
    created: created || Math.floor(Date.now() / 1000),
    model: model,
    choices: [{ index: 0, message: message, finish_reason: finish || "stop" }],
    usage: usage,
  };
}

async function handleChat(req, res, body) {
  let j;
  try { j = JSON.parse(body.toString("utf8")); } catch { return json(res, 400, { error: { message: "invalid JSON" } }); }
  if (!Array.isArray(j.messages) || j.messages.length === 0)
    return json(res, 400, { error: { message: "messages required" } });

  const accounts = loadAccounts();
  if (!accounts.length) return json(res, 401, { error: { message: "no accounts, login via /v1/login or the web UI" } });

  fixSystemOrder(j.messages);

  const wbBody = {
    model: resolveModel(j.model || "default-model"),
    messages: j.messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  const passthrough = ["tools", "tool_choice", "temperature", "top_p", "max_tokens", "reasoning_effort", "stop", "presence_penalty", "frequency_penalty"];
  for (const k of passthrough) {
    if (j[k] !== undefined) wbBody[k] = j[k];
  }
  const payload = JSON.stringify(wbBody);

  let queue;
  if (j.account) {
    const forced = accounts.find((a) => a.name === j.account);
    if (!forced) return json(res, 404, { error: { message: "account not found: " + j.account } });
    queue = [forced];
  } else {
    const seen = new Set();
    queue = [];
    const ordered = accounts
      .slice()
      .sort((a, b) => coolLeft(a.name) - coolLeft(b.name));
    for (const a of ordered) {
      if (!seen.has(a.name)) { seen.add(a.name); queue.push(a); }
    }
  }

  let up = null;
  let acc = null;
  let lastErr = null;
  let lastCode = null;
  let lastStatus = 502;

  for (const cand of queue) {
    if (!j.account && isCooling(cand.name)) continue;
    let r;
    try {
      r = await fetch(BASE + "/v2/chat/completions", {
        method: "POST",
        headers: wbHeaders(cand),
        body: payload,
      });
    } catch (e) {
      lastErr = "upstream fetch failed: " + e.message;
      cooldown.set(cand.name, banned());
      console.log("[chat] network fail on " + cand.name + ", cooldown 12h");
      continue;
    }

    if (r.ok) { up = r; acc = cand; break; }

    const t = await r.text();
    let code = null;
    try { code = JSON.parse(t).code; } catch {}
    lastErr = t.slice(0, 500);
    lastCode = code;
    lastStatus = r.status;

    if (QUOTA_ERR_CODES.includes(code)) {
      cooldown.set(cand.name, banned());
      console.log("[chat] " + cand.name + " -> code " + code + ", cooldown 12h, switching");
      continue;
    }
    break;
  }

  if (!up) {
    if (lastErr === null) {
      return json(res, 503, {
        error: {
          message: "all accounts are in cooldown (code 4006), retry after " + Math.ceil(coolLeft(queue[0].name) / 1000) + "s",
          code: 4006,
        },
      });
    }
    return json(res, lastStatus, { error: { message: lastErr, code: lastCode } });
  }

  if (acc) res.setHeader("X-WB-Account", acc.name);

  if (j.stream) {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-WB-Account": acc ? acc.name : "" });
    const reader = up.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const cleanDelta = (d) => {
      if (!d) return;
      if (d.content === "" || d.content === null) delete d.content;
      if (d.reasoning_content === "" || d.reasoning_content === null) delete d.reasoning_content;
      if (Array.isArray(d.tool_calls) && d.tool_calls.length === 0) delete d.tool_calls;
      if (d.function_call === null) delete d.function_call;
      if (d.refusal === "" || d.refusal === null) delete d.refusal;
      if (d.extra_fields === null) delete d.extra_fields;
    };
    try {
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        buf += decoder.decode(r.value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop();
        for (let line of lines) {
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (line.startsWith("data:")) {
            const data = line.slice(5).trim();
            if (data !== "[DONE]") {
              try {
                const chunk = JSON.parse(data);
                if (chunk.code !== undefined && QUOTA_ERR_CODES.includes(chunk.code)) {
                  if (acc) {
                    cooldown.set(acc.name, banned());
                    console.log("[chat] " + acc.name + " -> code " + chunk.code + " in stream, cooldown 12h");
                  }
                }
                if (chunk.choices) {
                  for (const ch of chunk.choices) cleanDelta(ch.delta);
                }
                line = "data: " + JSON.stringify(chunk);
              } catch {}
            }
          }
          res.write(line + "\n");
        }
      }
    } catch (e) { res.end(); return; }
    res.end();
    return;
  }

  const txt = await up.text();
  try {
    const chk = JSON.parse(txt);
    if (chk && chk.code !== undefined && QUOTA_ERR_CODES.includes(chk.code) && acc) {
      cooldown.set(acc.name, banned());
      console.log("[chat] " + acc.name + " -> code " + chk.code + " in body, cooldown 12h");
    }
  } catch {}
  json(res, 200, collectSSE(txt));
}

async function pollLogin(state) {
  const started = Date.now();
  while (Date.now() - started < 5 * 60 * 1000) {
    await new Promise((r) => setTimeout(r, 1500));
    let r;
    try { r = await fetch(BASE + "/v2/plugin/auth/token?state=" + state, { headers: { "User-Agent": UA } }); } catch { continue; }
    let j;
    try { j = await r.json(); } catch { continue; }
    if (j.code === 0 && j.data && j.data.accessToken) {
      const pl = jwtPayload(j.data.accessToken);
      const accounts = loadAccounts();
      const name = pl.email || pl.preferred_username || "account-" + (accounts.length + 1);
      const existing = accounts.find((a) => a.name === name);
      const rec = {
        name: name,
        accessToken: j.data.accessToken,
        refreshToken: j.data.refreshToken || "",
        userId: pl.sub || "",
      };
      if (existing) Object.assign(existing, rec);
      else accounts.push(rec);
      saveAccounts(accounts);
      console.log("[login] ok:", name);
      return;
    }
    if (j.code !== 11217) {
      console.log("[login] failed:", JSON.stringify(j).slice(0, 200));
      return;
    }
  }
  console.log("[login] timeout");
}

async function handleLogin(res) {
  let st;
  try {
    st = await fetch(BASE + "/v2/plugin/auth/state?platform=workbuddy-ai", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": UA },
      body: "{}",
    });
  } catch (e) {
    return json(res, 502, { error: { message: e.message } });
  }
  const stj = await st.json();
  if (stj.code !== 0) return json(res, 502, { error: stj });
  json(res, 200, { authUrl: stj.data.authUrl, state: stj.data.state });
  exec('start "" "' + stj.data.authUrl + '"');
  pollLogin(stj.data.state);
}

const num = (v) => {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

const normUnit = (u) => {
  const s = String(u || "").toLowerCase().trim();
  if (!s) return "credits";
  if (s === "credit" || s === "credits" || s === "cred" || s === "point" || s === "points" || s === "token" || s === "tokens") return "credits";
  return s;
};

async function fetchQuota(acc) {
  const body = { PageNumber: 1, PageSize: 20, ProductCode: "p_tcaca", Status: [], OnlyValidPeriod: true };
  const r = await fetch(BASE + "/v2/billing/meter/get-user-resource", {
    method: "POST",
    headers: wbHeaders(acc),
    body: JSON.stringify(body),
  });
  const t = await r.text();
  let j;
  try { j = JSON.parse(t); } catch { return { name: acc.name, error: t.slice(0, 200) }; }
  if (j.code !== 0) return { name: acc.name, error: j.msg };
  const data = j.data && j.data.Response && j.data.Response.Data;
  const list = (data && data.Accounts) || [];
  return {
    name: acc.name,
    userId: acc.userId,
    packages: list.map((a) => ({
      packageName: a.PackageName,
      remain: num(a.CapacityRemainPrecise !== undefined ? a.CapacityRemainPrecise : a.CapacityRemain),
      used: num(a.CapacityUsed),
      size: num(a.CapacitySize),
      unit: a.CapacityUnit,
      cycleStart: a.CycleStartTime,
      cycleEnd: a.CycleEndTime,
    })),
  };
}

function aggregateQuota(list) {
  const byPkg = new Map();
  let total = { unit: "credits", remain: 0, used: 0, size: 0 };
  let accountsOk = 0, accountsErr = 0, accountsWithPkgs = 0;
  for (const acc of list) {
    if (acc.error) { accountsErr++; continue; }
    accountsOk++;
    if (acc.packages.length) accountsWithPkgs++;
    for (const p of acc.packages) {
      const nu = normUnit(p.unit);
      const key = (p.packageName || "unknown") + "\u0000" + nu;
      let e = byPkg.get(key);
      if (!e) {
        e = { packageName: p.packageName, unit: nu, remain: 0, used: 0, size: 0, accounts: 0, cycleStart: p.cycleStart, cycleEnd: p.cycleEnd };
        byPkg.set(key, e);
      }
      e.remain += p.remain;
      e.used += p.used;
      e.size += p.size;
      e.accounts++;
      if (p.cycleEnd && (!e.cycleEnd || p.cycleEnd > e.cycleEnd)) e.cycleEnd = p.cycleEnd;
      if (p.cycleStart && (!e.cycleStart || p.cycleStart < e.cycleStart)) e.cycleStart = p.cycleStart;
      if (nu === "credits") {
        total.remain += p.remain;
        total.used += p.used;
        total.size += p.size;
      }
    }
  }
  return {
    packages: [...byPkg.values()].sort((a, b) => (b.remain - a.remain)),
    total,
    accounts: accountsOk,
    accountsWithPackages: accountsWithPkgs,
    accountsFailed: accountsErr,
  };
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");
  const p = u.pathname;
  try {
    if ((p === "/" || p === "/index.html") && req.method === "GET") {
      const html = fs.readFileSync(INDEX_FILE);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html);
    }

    if (p === "/v1/models" && req.method === "GET") {
      return json(res, 200, {
        object: "list",
        data: MODELS.map((m) => ({ id: m, object: "model", created: 0, owned_by: "workbuddy" })),
      });
    }

    if (p === "/v1/chat/completions" && req.method === "POST") {
      return await handleChat(req, res, await readBody(req));
    }

    if (p === "/v1/login" && req.method === "POST") {
      return await handleLogin(res);
    }

    if (p === "/v1/accounts" && req.method === "GET") {
      const accounts = loadAccounts().map((a) => ({
        name: a.name,
        userId: a.userId || jwtPayload(a.accessToken).sub || "",
        email: jwtPayload(a.accessToken).email || "",
      }));
      return json(res, 200, accounts);
    }

    if (p === "/v1/accounts" && req.method === "POST") {
      return json(res, 410, { error: { message: "manual token auth is disabled, use /v1/login" } });
    }

    if (p === "/v1/accounts/delete" && req.method === "POST") {
      const j = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const accounts = loadAccounts();
      const next = accounts.filter((a) => a.name !== j.name);
      saveAccounts(next);
      return json(res, 200, { ok: true, removed: accounts.length - next.length });
    }

    if (p === "/v1/status" && req.method === "GET") {
      const accounts = loadAccounts();
      const now = Date.now();
      return json(res, 200, {
        cooldownMs: COOLDOWN_MS,
        quotaCodes: QUOTA_ERR_CODES,
        accounts: accounts.map((a) => ({
          name: a.name,
          ready: !isCooling(a.name),
          cooldownLeftMs: coolLeft(a.name),
          cooldownUntil: cooldown.has(a.name) ? new Date(cooldown.get(a.name)).toISOString() : null,
        })),
        now: new Date(now).toISOString(),
      });
    }

    if (p === "/v1/reset-cooldown" && req.method === "POST") {
      const j = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      if (j.name) {
        if (!cooldown.delete(j.name)) return json(res, 404, { error: { message: "no cooldown for " + j.name } });
      } else {
        cooldown.clear();
      }
      return json(res, 200, { ok: true, cooling: cooldown.size });
    }

    if (p === "/v1/quota" && req.method === "GET") {
      const accounts = loadAccounts();
      const out = [];
      for (const acc of accounts) {
        try { out.push(await fetchQuota(acc)); }
        catch (e) { out.push({ name: acc.name, error: e.message }); }
      }
      const agg = aggregateQuota(out);
      if (u.searchParams.get("raw") === "1") return json(res, 200, { aggregate: agg, accounts: out });
      return json(res, 200, agg);
    }

    json(res, 404, { error: { message: "not found" } });
  } catch (e) {
    if (!res.headersSent) json(res, 500, { error: { message: e.message } });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log("wb-gateway http://" + HOST + ":" + PORT);
});
