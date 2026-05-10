let allCookies = [];
let currentTabUrl = "";
let currentHost = "";

async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabUrl = tab?.url || "";

  try {
    currentHost = new URL(currentTabUrl).hostname;
  } catch {
    currentHost = "";
  }
}

async function loadCookies() {
  await getCurrentTab();

  const advanced = document.getElementById("advancedMode").checked;

  if (advanced) {
    allCookies = await chrome.cookies.getAll({});
  } else {
    if (!currentTabUrl.startsWith("http")) {
      allCookies = [];
    } else {
      allCookies = await chrome.cookies.getAll({ url: currentTabUrl });
    }
  }

  render();
}

function render() {
  const q = document.getElementById("search").value.toLowerCase();
  const sortEl = document.getElementById("sort");
  const sortBy = sortEl ? sortEl.value : "domain";

  let data = allCookies.filter(c =>
    c.domain.toLowerCase().includes(q) ||
    c.name.toLowerCase().includes(q) ||
    String(c.value || "").toLowerCase().includes(q)
  );

  data.sort((a, b) => {
    const aCurrent = isCurrentSiteCookie(a) ? 1 : 0;
    const bCurrent = isCurrentSiteCookie(b) ? 1 : 0;

    if (aCurrent !== bCurrent) return bCurrent - aCurrent;

    if (sortBy === "domain") return a.domain.localeCompare(b.domain);
    if (sortBy === "name") return a.name.localeCompare(b.name);
    if (sortBy === "expiry") return (a.expirationDate || 0) - (b.expirationDate || 0);
    if (sortBy === "secure") return Number(b.secure) - Number(a.secure);

    return 0;
  });

  document.getElementById("count").textContent =
    `${data.length} cookies | Active site: ${currentHost || "-"}`

  const list = document.getElementById("list");
  list.innerHTML = "";

  data.forEach(cookie => {
    const item = document.createElement("div");
    item.className = isCurrentSiteCookie(cookie) ? "cookie active-site" : "cookie";

    const expired = cookie.expirationDate
      ? new Date(cookie.expirationDate * 1000).toLocaleString()
      : "Session";

    item.innerHTML = `
      <b>${escapeHtml(cookie.name)}</b>
      <small>${escapeHtml(cookie.domain)}${escapeHtml(cookie.path)}</small>

      <label>Value</label>
      <textarea class="edit-value">${escapeHtml(cookie.value || "")}</textarea>

      <p>Secure: ${cookie.secure ? "Yes" : "No"} | HttpOnly: ${cookie.httpOnly ? "Yes" : "No"}</p>
      <p>SameSite: ${cookie.sameSite || "-"} | Expires: ${expired}</p>

      <div class="btn-row">
        <button class="copy">Copy</button>
        <button class="save">Save</button>
        <button class="delete">Delete</button>
      </div>
    `;
    item.querySelector(".copy").onclick = async () => {
      await navigator.clipboard.writeText(`${cookie.name}=${cookie.value}`);
      flash(item.querySelector(".copy"), "Copied");
    };

    item.querySelector(".save").onclick = async () => {
      const newValue = item.querySelector(".edit-value").value;
      await setCookieFromObjectSafe({
        ...cookie,
        value: newValue
      });
      flash(item.querySelector(".save"), "Saved");
      await loadCookies();
    };

    item.querySelector(".delete").onclick = async () => {
      await chrome.cookies.remove({
        url: getCookieUrl(cookie),
        name: cookie.name
      });
      await loadCookies();
    };

    list.appendChild(item);
  });
}


function exportCookies() {
  const advanced = document.getElementById("advancedMode").checked;

  const data = advanced
    ? allCookies
    : allCookies.filter(isCurrentSiteCookie);

  const exportData = {
    type: "cookie-sorter-export",
    version: 1,
    exportedAt: new Date().toISOString(),
    scope: advanced ? "all" : "current-site",
    currentHost,
    cookies: data.map(c => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: c.sameSite,
      expirationDate: c.expirationDate || null,
      storeId: c.storeId
    }))
  };

  const json = JSON.stringify(exportData, null, 2);
  document.getElementById("exportBox").value = json;
  navigator.clipboard.writeText(json);

  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = advanced
    ? "cookies-all.json"
    : `cookies-${currentHost || "current-site"}.json`;
  a.click();

  URL.revokeObjectURL(url);
}


function detectAndParseCookies(text) {
  const raw = text.trim();

  if (!raw) return null;

  // =====================================================
  // 1. JSON
  // =====================================================
  if (raw.startsWith("{") || raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw);

      let cookies = [];

      if (Array.isArray(parsed)) {
        cookies = parsed;
      } else if (Array.isArray(parsed.cookies)) {
        cookies = parsed.cookies;
      } else if (Array.isArray(parsed.data)) {
        cookies = parsed.data;
      }

      if (cookies.length) {
        return cookies.map(c => ({
          name: c.name || "",
          value: c.value || "",
          domain: c.domain || currentHost,
          path: c.path || "/",
          secure: Boolean(c.secure),
          httpOnly: Boolean(c.httpOnly),
          sameSite: normalizeSameSite(c.sameSite),
          expirationDate: normalizeExpiry(
            c.expirationDate ||
            c.expiration ||
            c.expires
          )
        })).filter(c => c.name);
      }
    } catch {}
  }

  // =====================================================
  // 2. Netscape cookies.txt
  // =====================================================
  if (
    raw.includes("\tTRUE\t") ||
    raw.includes("\tFALSE\t") ||
    raw.includes("# Netscape")
  ) {
    const lines = raw
      .split(/\r?\n/)
      .map(x => x.trim())
      .filter(Boolean);

    const cookies = [];

    for (const line of lines) {
      if (line.startsWith("#") && !line.startsWith("#HttpOnly_")) {
        continue;
      }

      const clean = line.replace(/^#HttpOnly_/, "");

      const parts = clean.split("\t");

      if (parts.length < 7) continue;

      cookies.push({
        domain: parts[0],
        path: parts[2] || "/",
        secure: String(parts[3]).toUpperCase() === "TRUE",
        expirationDate: normalizeExpiry(parts[4]),
        name: parts[5],
        value: parts.slice(6).join("\t"),
        httpOnly: line.startsWith("#HttpOnly_")
      });
    }

    if (cookies.length) return cookies;
  }

  // =====================================================
  // 3. Header cookies:
  // a=b; c=d;
  // =====================================================
  if (raw.includes("=")) {
    return raw
      .split(";")
      .map(x => x.trim())
      .filter(Boolean)
      .map(part => {
        const idx = part.indexOf("=");

        if (idx === -1) return null;

        const name = part.slice(0, idx).trim();
        const value = part.slice(idx + 1).trim();

        return {
          name,
          value,
          domain: currentHost,
          path: "/",
          secure: currentTabUrl.startsWith("https://"),
          httpOnly: false
        };
      })
      .filter(c => c && c.name);
  }

  return null;
}

function normalizeSameSite(value) {
  if (!value) return null;

  const v = String(value).toLowerCase();

  if (v === "lax") return "lax";
  if (v === "strict") return "strict";
  if (v === "none" || v === "no_restriction" || v === "no_restriction") {
    return "no_restriction";
  }

  return null;
}

function normalizeExpiry(value) {
  if (!value) return null;

  const n = Number(value);

  if (!Number.isFinite(n)) return null;

  // kalau timestamp milidetik, ubah ke detik
  if (n > 9999999999) return Math.floor(n / 1000);

  return n;
}

function isCookieAttribute(name) {
  const n = String(name).toLowerCase();

  return [
    "path",
    "domain",
    "expires",
    "max-age",
    "samesite",
    "secure",
    "httponly"
  ].includes(n);
}

async function importCookiesFromText(text) {
  let cookies = detectAndParseCookies(text);

  if (!Array.isArray(cookies) || cookies.length === 0) {
    alert("Unsupported cookie format.");
    return;
  }

  const advanced = document.getElementById("advancedMode").checked;

  if (!advanced) {
    cookies = cookies.filter(c => {
      const d = String(c.domain || currentHost || "").replace(/^\./, "");
      return currentHost === d || currentHost.endsWith("." + d);
    });
  }

  const ok = confirm(
    `Detected ${cookies.length} cookies.\n\n` +
    `Mode: ${advanced ? "All cookies" : "Current site only"}\n\n` +
    `Continue importing?`
  );

  if (!ok) return;

  let success = 0;
  let failed = 0;

  for (const cookie of cookies) {
    try {
      await setCookieFromObjectSafe(cookie);
      success++;
    } catch (err) {
      console.warn("Import gagal:", cookie?.name, err);
      failed++;
    }

    await sleep(50);
  }

  alert(
    `Import completed.\n\n` +
    `Success: ${success}\n` +
    `Failed: ${failed}`
  );
  await loadCookies();
}

async function importCookiesFromFile(file) {
  const text = await file.text();
  document.getElementById("exportBox").value = text;

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    alert("File JSON not valid");
    return;
  }

  let cookies = Array.isArray(parsed) ? parsed : parsed.cookies;

  if (!Array.isArray(cookies)) {
    alert("Format cookies not supported");
    return;
  }

  // Kalau advanced tidak aktif, import hanya cookie domain web saat ini
  const advanced = document.getElementById("advancedMode").checked;

  if (!advanced) {
    cookies = cookies.filter(c => {
      const d = String(c.domain || "").replace(/^\./, "");
      return currentHost === d || currentHost.endsWith("." + d);
    });
  }

  const confirmImport = confirm(
    `Import ${cookies.length} cookie?\n\n` +
    `Mode: ${advanced ? "All cookie" : "Current web"}`
  );

  if (!confirmImport) return;

  let success = 0;
  let failed = 0;

  for (const cookie of cookies) {
    try {
      await setCookieFromObjectSafe(cookie);
      success++;
    } catch (err) {
      console.warn("Import Failed:", cookie?.name, cookie?.domain, err);
      failed++;
    }

    // jeda kecil agar Chrome tidak freeze/crash
    await sleep(30);
  }

  alert(`Import completed.\nSucced: ${success}\nFailed: ${failed}`);
  await loadCookies();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


async function setCookieFromObjectSafe(cookie) {
  if (!cookie || !cookie.name) {
    throw new Error("Cookie name is missing");
  }

  const domain = String(cookie.domain || currentHost || "")
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^\./, "");

  if (!domain) {
    throw new Error("Domain is empty");
  }

  const path = cookie.path || "/";
  const secure = Boolean(cookie.secure) || currentTabUrl.startsWith("https://");

  const details = {
    url: `${secure ? "https" : "http"}://${domain}${path}`,
    name: String(cookie.name),
    value: String(cookie.value || ""),
    path,
    secure
  };

  if (cookie.httpOnly !== undefined) {
    details.httpOnly = Boolean(cookie.httpOnly);
  }

  if (cookie.domain && String(cookie.domain).startsWith(".")) {
    details.domain = String(cookie.domain);
  }

  const sameSite = normalizeSameSite(cookie.sameSite);

  if (sameSite) {
    details.sameSite = sameSite;
  }

  const exp = normalizeExpiry(cookie.expirationDate);

  if (exp && exp > Date.now() / 1000) {
    details.expirationDate = exp;
  }

  return chrome.cookies.set(details);
}

function copyCurrentSiteCookies() {
  const cookies = allCookies.filter(isCurrentSiteCookie);

  const text = cookies
    .map(c => `${c.name}=${c.value}`)
    .join("; ");

  navigator.clipboard.writeText(text);
  document.getElementById("exportBox").value = text;
}

function isCurrentSiteCookie(cookie) {
  if (!currentHost) return false;

  const domain = cookie.domain.startsWith(".")
    ? cookie.domain.slice(1)
    : cookie.domain;

  return currentHost === domain || currentHost.endsWith("." + domain);
}

function getCookieUrl(cookie) {
  const protocol = cookie.secure ? "https://" : "http://";

  const domain = String(cookie.domain || currentHost || "")
    .replace(/^\./, "");

  const path = cookie.path || "/";

  return protocol + domain + path;
}

function escapeHtml(str = "") {
  return String(str).replace(/[&<>"']/g, s => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[s]));
}

function flash(button, text) {
  const old = button.textContent;
  button.textContent = text;

  setTimeout(() => {
    button.textContent = old;
  }, 1000);
}

document.getElementById("search").oninput = render;
const sortEl = document.getElementById("sort");
if (sortEl) sortEl.onchange = render;
document.getElementById("refresh").onclick = loadCookies;
document.getElementById("advancedMode").onchange = loadCookies;
document.getElementById("export").onclick = exportCookies;
document.getElementById("copyCurrent").onclick = copyCurrentSiteCookies;

document.getElementById("importBtn").onclick = async () => {
  const text = document.getElementById("exportBox").value.trim();

  if (!text) {
    alert(
    "Paste cookies first.\n\n" +
    "Supported formats:\n" +
    "- JSON\n" +
    "- name=value\n" +
    "- cookie header\n" +
    "- Netscape cookies.txt"
  );
  return;
  }

  await importCookiesFromText(text);
};

loadCookies();
