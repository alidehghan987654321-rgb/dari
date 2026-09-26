"use strict";

const $ = (sel) => document.querySelector(sel);
const form = $("#form");
const input = $("#url");
const goButton = $("#go");
const statusCard = $("#status");
const errorCard = $("#error");
const results = $("#results");

const fa = (n) => Number(n).toLocaleString("fa-IR");
const POLL_MS = 1000;

function formatSize(bytes) {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${fa(mb.toFixed(1))} مگابایت`;
  return `${fa(Math.round(bytes / 1024))} کیلوبایت`;
}

function formatDuration(seconds) {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  const text = h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
  return text.replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[d]);
}

function showStatus(title, { fraction = null, detail = "" } = {}) {
  errorCard.hidden = true;
  statusCard.hidden = false;
  $("#status-title").textContent = title;
  const bar = $("#status-bar");
  bar.parentElement.classList.toggle("indeterminate", fraction === null);
  bar.style.width = fraction === null ? "" : `${Math.round(fraction * 100)}%`;
  $("#status-percent").textContent = fraction === null ? "" : `${fa(Math.round(fraction * 100))}٪`;
  $("#status-detail").textContent = detail;
}

function showError(message) {
  statusCard.hidden = true;
  errorCard.hidden = false;
  $("#error-text").textContent = message || "خطایی رخ داد. دوباره امتحان کنید.";
}

function setBusy(busy) {
  goButton.disabled = busy;
  input.readOnly = busy;
}

function renderJob(job) {
  if (job.status === "queued") {
    showStatus("در صف دانلود...", { detail: "چند دانلود دیگر در جریان است؛ کمی صبر کنید." });
  } else if (job.status === "downloading") {
    const p = job.progress;
    if (!p) {
      showStatus("در حال بررسی لینک...");
    } else {
      let detail = p.total ? `${formatSize(p.downloaded)} از ${formatSize(p.total)}` : formatSize(p.downloaded);
      if (p.speed) detail += `  •  ${formatSize(p.speed)}/ثانیه`;
      showStatus("در حال دانلود...", { fraction: p.fraction, detail });
    }
  } else if (job.status === "error") {
    showError(job.error);
  } else if (job.status === "done") {
    statusCard.hidden = true;
    renderResults(job);
  }
}

function renderResults(job) {
  results.replaceChildren();
  const template = $("#result-tpl");
  for (const file of job.files) {
    const card = template.content.firstElementChild.cloneNode(true);
    const preview = card.querySelector(".preview");
    const inlineUrl = `${file.url}?inline=1`;
    if (file.kind === "video") {
      const video = document.createElement("video");
      Object.assign(video, { src: inlineUrl, controls: true, preload: "metadata", playsInline: true });
      preview.append(video);
    } else if (file.kind === "photo") {
      const img = document.createElement("img");
      Object.assign(img, { src: inlineUrl, alt: file.title || "" });
      preview.append(img);
    } else if (file.kind === "audio") {
      const audio = document.createElement("audio");
      Object.assign(audio, { src: inlineUrl, controls: true, preload: "metadata" });
      preview.append(audio);
    } else {
      preview.remove();
      card.style.gridTemplateColumns = "1fr";
    }

    card.querySelector(".title").textContent = file.title || "ویدیو";
    const meta = [];
    if (file.uploader) meta.push(`👤 ${file.uploader}`);
    if (file.duration) meta.push(`⏱ ${formatDuration(file.duration)}`);
    if (file.width && file.height) meta.push(`🎞 ${fa(file.height)}p`);
    meta.push(`📦 ${formatSize(file.size)}`);
    // One element per item so Latin names don't reorder the Persian around them.
    card.querySelector(".meta").replaceChildren(
      ...meta.map((text) => Object.assign(document.createElement("span"), { textContent: text })),
    );

    const download = card.querySelector(".download");
    download.href = file.url;
    download.querySelector("span").textContent = file.kind === "video" ? "دانلود ویدیو" : "دانلود فایل";
    const source = card.querySelector(".source");
    if (/^https?:\/\//.test(file.source || "")) source.href = file.source;
    else source.remove();
    results.append(card);
  }
  if (job.too_large) {
    const note = document.createElement("p");
    note.className = "muted";
    note.textContent = `${fa(job.too_large)} فایل به دلیل حجم زیاد دانلود نشد.`;
    results.append(note);
  }
}

async function poll(id) {
  for (;;) {
    let job;
    try {
      const res = await fetch(`/api/jobs/${encodeURIComponent(id)}`);
      job = await res.json();
      if (!res.ok) return showError(job.detail);
    } catch {
      await new Promise((r) => setTimeout(r, POLL_MS * 2)); // flaky connection: keep trying
      continue;
    }
    renderJob(job);
    if (job.status === "done" || job.status === "error") return;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

async function start(url) {
  setBusy(true);
  results.replaceChildren();
  showStatus("در حال بررسی لینک...");
  try {
    const res = await fetch("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = typeof data.detail === "string" ? data.detail : "لینک نامعتبر است.";
      return showError(detail);
    }
    await poll(data.id);
  } catch {
    showError("ارتباط با سرور برقرار نشد. اینترنت خود را بررسی کنید.");
  } finally {
    setBusy(false);
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const url = input.value.trim();
  if (url) start(url);
});

if (navigator.clipboard?.readText) {
  const paste = $("#paste");
  paste.hidden = false;
  paste.addEventListener("click", async () => {
    try {
      input.value = (await navigator.clipboard.readText()).trim();
      input.focus();
    } catch {
      input.focus();
    }
  });
}

// Links like /?url=https://... start right away (handy for sharing).
const shared = new URLSearchParams(location.search).get("url");
if (shared) {
  input.value = shared;
  start(shared);
}

fetch("/api/info")
  .then((res) => res.json())
  .then((info) => {
    if (!info.bot_username) return;
    const base = `https://t.me/${info.bot_username}`;
    for (const link of document.querySelectorAll("[data-tg-link]")) {
      link.href = base + (link.dataset.tgLink || "");
      link.target = "_blank";
      link.rel = "noopener";
    }
    for (const el of document.querySelectorAll(".tg-only")) el.hidden = false;
  })
  .catch(() => {});
