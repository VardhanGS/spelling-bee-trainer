"use strict";

// ---------- Config ----------
const WORDS_PER_ROUND = 10;
const MASTERY_STREAK = 2;       // get a missed word right this many times in a row to "master" it
const REVIEW_PER_ROUND = 4;     // how many tricky words to fold into a normal round

// ---------- Word index (word string -> full {w,s,d}) ----------
const WORD_INDEX = {};
Object.values(WORD_LEVELS).flat().forEach((o) => { if (!WORD_INDEX[o.w]) WORD_INDEX[o.w] = o; });

// ---------- Persistent store (per player profile) ----------
function load(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}

const AVATARS = ["🐝", "🦄", "🐯", "🦊", "🐸", "🐵", "🐼", "🦁", "🐙", "🐢", "🦖", "🚀", "⭐", "🌈", "🦋", "🐬"];
let profiles = load("bee_profiles", []);   // [{id, name, avatar}]
let activeId = localStorage.getItem("bee_activeProfile") || "";

const STORE = {
  stats: {},  // word -> {right,wrong,streak,mastered,everWrong,lastSeen}
  daily: {},  // "YYYY-MM-DD" -> {attempts,correct,wrong,mastered,mistakes:[]}
};
let bestStreak = 0;

function genId() {
  return "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
function saveProfiles() { localStorage.setItem("bee_profiles", JSON.stringify(profiles)); }
function activeProfile() { return profiles.find((p) => p.id === activeId) || profiles[0]; }
function pkey(name, id = activeId) { return "bee_" + id + "_" + name; }
function streakOf(id) { return Number(localStorage.getItem(pkey("bestStreak", id)) || 0); }

// Make sure at least one profile exists; migrate legacy single-user data on first upgrade.
function ensureProfile() {
  profiles = load("bee_profiles", []);
  if (profiles.length === 0) {
    const id = genId();
    profiles = [{ id, name: "Player 1", avatar: "🐝" }];
    saveProfiles();
    activeId = id;
    localStorage.setItem("bee_activeProfile", id);
    // Carry over progress saved before profiles existed.
    const legacy = { wordStats: "bee_wordStats", daily: "bee_daily", bestStreak: "bee_bestStreak" };
    for (const [name, oldKey] of Object.entries(legacy)) {
      const val = localStorage.getItem(oldKey);
      if (val !== null) { localStorage.setItem(pkey(name, id), val); localStorage.removeItem(oldKey); }
    }
  }
  if (!activeId || !profiles.some((p) => p.id === activeId)) {
    activeId = profiles[0].id;
    localStorage.setItem("bee_activeProfile", activeId);
  }
}

function loadActiveData() {
  STORE.stats = load(pkey("wordStats"), {});
  STORE.daily = load(pkey("daily"), {});
  bestStreak = Number(localStorage.getItem(pkey("bestStreak")) || 0);
}

function persist() {
  localStorage.setItem(pkey("wordStats"), JSON.stringify(STORE.stats));
  localStorage.setItem(pkey("daily"), JSON.stringify(STORE.daily));
}

function todayKey(d = new Date()) {
  return d.getFullYear() + "-" +
    String(d.getMonth() + 1).padStart(2, "0") + "-" +
    String(d.getDate()).padStart(2, "0");
}

function statFor(word) {
  if (!STORE.stats[word]) {
    STORE.stats[word] = { right: 0, wrong: 0, streak: 0, mastered: false, everWrong: false, lastSeen: null };
  }
  return STORE.stats[word];
}
function dayFor(key = todayKey()) {
  if (!STORE.daily[key]) {
    STORE.daily[key] = { attempts: 0, correct: 0, wrong: 0, mastered: 0, mistakes: [] };
  }
  return STORE.daily[key];
}

// A word "needs practice" if it has ever been missed and is not yet mastered.
function needsPractice(word) {
  const s = STORE.stats[word];
  return !!s && s.everWrong && !s.mastered;
}
function reviewWords() {
  return Object.keys(STORE.stats).filter(needsPractice).map((w) => WORD_INDEX[w]).filter(Boolean);
}

function recordResult(word, correct) {
  const s = statFor(word);
  const d = dayFor();
  d.attempts++;
  s.lastSeen = todayKey();
  if (correct) {
    s.right++; s.streak++;
    d.correct++;
    if (s.everWrong && !s.mastered && s.streak >= MASTERY_STREAK) {
      s.mastered = true;
      d.mastered++;
    }
  } else {
    s.wrong++; s.streak = 0; s.everWrong = true; s.mastered = false;
    d.wrong++;
    if (!d.mistakes.includes(word)) d.mistakes.push(word);
  }
  persist();
}

// ---------- Quiz state ----------
let mode = "test";          // "test" | "practice" | "review"
let levelName = "";
let roundWords = [];
let idx = 0;
let score = 0;
let streak = 0;
let missed = [];
let answered = false;

// ---------- Elements ----------
const $ = (id) => document.getElementById(id);
const screens = { home: $("home"), quiz: $("quiz"), results: $("results"), report: $("report"), profiles: $("profiles") };
function show(name) {
  Object.values(screens).forEach((s) => s.classList.remove("active"));
  screens[name].classList.add("active");
  if (name === "home") refreshHome();
  if (name === "profiles") renderProfiles();
}

// ---------- Speech ----------
let voices = [];
function loadVoices() { voices = window.speechSynthesis ? speechSynthesis.getVoices() : []; }
if (window.speechSynthesis) { loadVoices(); speechSynthesis.onvoiceschanged = loadVoices; }
function pickVoice() {
  if (!voices.length) loadVoices();
  const prefer = ["Samantha", "Google US English", "Microsoft Aria", "Karen", "Daniel"];
  for (const name of prefer) {
    const v = voices.find((vo) => vo.name.includes(name));
    if (v) return v;
  }
  return voices.find((v) => v.lang && v.lang.startsWith("en")) || voices[0] || null;
}
function speak(text, rate = 0.85) {
  if (!window.speechSynthesis) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const v = pickVoice();
  if (v) u.voice = v;
  u.lang = (v && v.lang) || "en-US";
  u.rate = rate; u.pitch = 1.05;
  speechSynthesis.speak(u);
}
const current = () => roundWords[idx];
function sayWord(rate = 0.85) { if (current()) speak(current().w, rate); }

// ---------- Levels ----------
function fillLevels() {
  const sel = $("levelSelect");
  sel.innerHTML = "";
  Object.keys(WORD_LEVELS).forEach((name) => {
    const o = document.createElement("option");
    o.value = name;
    o.textContent = `${name}  (${WORD_LEVELS[name].length} words)`;
    sel.appendChild(o);
  });
  const all = document.createElement("option");
  const total = Object.values(WORD_LEVELS).reduce((n, a) => n + a.length, 0);
  all.value = "__ALL__";
  all.textContent = `⭐ All words mixed  (${total} words)`;
  sel.appendChild(all);
}
function wordsForLevel(name) {
  if (name === "__ALL__") return Object.values(WORD_LEVELS).flat();
  return WORD_LEVELS[name] || [];
}
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- Build a round (folds tricky words back in) ----------
function buildRound(chosenMode) {
  if (chosenMode === "review") {
    return shuffle(reviewWords()).slice(0, Math.max(WORDS_PER_ROUND, 0)) ; // all tricky words, capped per round
  }
  const pool = shuffle(wordsForLevel(levelName));
  const seen = new Set();
  const round = [];
  // 1) Tricky words first — prefer ones from the chosen level, then any tricky word.
  const reviewsInLevel = pool.filter((w) => needsPractice(w.w));
  const reviewsGlobal = shuffle(reviewWords()).filter((w) => !reviewsInLevel.includes(w));
  for (const w of [...reviewsInLevel, ...reviewsGlobal]) {
    if (round.length >= REVIEW_PER_ROUND) break;
    if (!seen.has(w.w)) { round.push(w); seen.add(w.w); }
  }
  // 2) Fill the rest with fresh words from the level.
  for (const w of pool) {
    if (round.length >= WORDS_PER_ROUND) break;
    if (!seen.has(w.w)) { round.push(w); seen.add(w.w); }
  }
  return shuffle(round);
}

function startRound(chosenMode) {
  mode = chosenMode;
  levelName = $("levelSelect").value;
  roundWords = buildRound(chosenMode);
  if (!roundWords.length) {
    // Nothing to review yet.
    alert("No tricky words yet — play a round first and any missed words will show up here! 🐝");
    return;
  }
  idx = 0; score = 0; streak = 0; missed = [];
  show("quiz");
  renderWord();
}

function renderWord() {
  answered = false;
  const w = current();
  $("progressText").textContent = `${idx + 1} / ${roundWords.length}`;
  $("progressFill").style.width = `${(idx / roundWords.length) * 100}%`;
  $("score").textContent = score;
  $("hintBox").textContent = "";
  $("feedback").className = "feedback";
  $("feedback").textContent = "";
  $("answerInput").value = "";
  $("answerInput").disabled = false;
  $("checkBtn").disabled = false;
  $("nextBtn").classList.add("hidden");
  // Practice mode shows the word; test & review hide it.
  $("practiceWord").textContent = mode === "practice" ? w.w : "";
  setTimeout(() => sayWord(), 250);
  $("answerInput").focus();
}

function normalize(s) { return s.trim().toLowerCase(); }

function checkAnswer() {
  if (answered) return;
  const w = current();
  const guess = normalize($("answerInput").value);
  if (!guess) { $("answerInput").focus(); return; }

  answered = true;
  $("answerInput").disabled = true;
  $("checkBtn").disabled = true;
  const fb = $("feedback");
  const correct = guess === w.w.toLowerCase();
  recordResult(w.w, correct);

  if (correct) {
    score++; streak++;
    if (streak > bestStreak) { bestStreak = streak; localStorage.setItem(pkey("bestStreak"), String(bestStreak)); }
    fb.className = "feedback good";
    fb.textContent = pickPraise();
    speak("Correct! " + w.w, 0.9);
  } else {
    streak = 0;
    missed.push(w);
    fb.className = "feedback bad";
    fb.innerHTML = `Almost! It's <span class="correct-spell">${spaced(w.w)}</span>`;
    speak("The correct spelling is " + spellOut(w.w), 0.8);
    $("practiceWord").textContent = w.w;
  }
  $("score").textContent = score;
  $("progressFill").style.width = `${((idx + 1) / roundWords.length) * 100}%`;
  $("nextBtn").classList.remove("hidden");
  $("nextBtn").focus();
}

function spaced(word) { return word.split("").join(" "); }
function spellOut(word) { return word.split("").join("-") + ". " + word; }

// Hide the target word (and simple plural/verb forms) so a hint doesn't give the spelling away.
function maskWord(text, word, replacement) {
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp("\\b" + esc + "(s|es|ing|ed|d)?\\b", "ig");
  return text.replace(re, replacement);
}
const PRAISE = ["⭐ Correct!", "🎉 You got it!", "👏 Great spelling!", "🌟 Perfect!", "🔥 Awesome!"];
function pickPraise() { return PRAISE[Math.floor(Math.random() * PRAISE.length)]; }

function nextWord() {
  idx++;
  if (idx >= roundWords.length) return finishRound();
  renderWord();
}

function finishRound() {
  show("results");
  const total = roundWords.length;
  $("resultSummary").innerHTML =
    `You spelled <b>${score}</b> out of <b>${total}</b> correctly!<br>` +
    `${stars(score, total)}<br>🏆 Best streak: ${bestStreak}`;
  const box = $("missedList");
  if (missed.length) {
    box.innerHTML = "<h3>Words to practice:</h3>" +
      missed.map((m) => `<div><span class="mw">${m.w}</span></div>`).join("");
  } else {
    box.innerHTML = "<h3>Perfect round — no misses! 🌟</h3>";
  }
  $("bestStreak").textContent = bestStreak;
}
function stars(score, total) {
  const pct = total ? score / total : 0;
  const n = pct === 1 ? 5 : pct >= 0.8 ? 4 : pct >= 0.6 ? 3 : pct >= 0.4 ? 2 : 1;
  return "⭐".repeat(n) + "☆".repeat(5 - n);
}

// ---------- Home refresh (active profile + tricky-word count) ----------
function refreshHome() {
  const p = activeProfile();
  if (p) {
    $("chipAvatar").textContent = p.avatar;
    $("chipName").textContent = p.name;
  }
  const n = reviewWords().length;
  $("reviewCount").textContent = n;
  $("reviewBtn").classList.toggle("dim", n === 0);
  $("bestStreak").textContent = bestStreak;
}

// ---------- Player profiles ----------
let pendingAvatar = AVATARS[0];

function renderProfiles() {
  const list = $("profileList");
  list.innerHTML = profiles.map((p) => `
    <div class="profile-card ${p.id === activeId ? "active" : ""}">
      <button class="profile-pick" data-pick="${p.id}">
        <span class="pc-avatar">${p.avatar}</span>
        <span class="pc-name">${escapeHtml(p.name)}</span>
        <span class="pc-streak">🏆 ${streakOf(p.id)}</span>
        ${p.id === activeId ? '<span class="pc-badge">Playing</span>' : ""}
      </button>
      <div class="pc-actions">
        <button class="pc-edit" data-edit="${p.id}" title="Rename">✎</button>
        <button class="pc-del" data-del="${p.id}" title="Delete">🗑</button>
      </div>
    </div>`).join("");

  $("avatarRow").innerHTML = AVATARS.map((a) =>
    `<button class="avatar-opt ${a === pendingAvatar ? "sel" : ""}" data-avatar="${a}">${a}</button>`
  ).join("");
}

function switchProfile(id) {
  activeId = id;
  localStorage.setItem("bee_activeProfile", id);
  loadActiveData();
  refreshHome();
}

function addProfile() {
  const input = $("newProfileName");
  const name = input.value.trim();
  if (!name) { input.focus(); return; }
  const id = genId();
  profiles.push({ id, name, avatar: pendingAvatar });
  saveProfiles();
  input.value = "";
  pendingAvatar = AVATARS[0];
  switchProfile(id);      // new player starts fresh
  renderProfiles();
}

function renameProfile(id) {
  const p = profiles.find((x) => x.id === id);
  if (!p) return;
  const name = prompt("New name for this player:", p.name);
  if (name && name.trim()) {
    p.name = name.trim();
    saveProfiles();
    renderProfiles();
    refreshHome();
  }
}

function deleteProfile(id) {
  if (profiles.length <= 1) { alert("You need at least one player. Add another before deleting this one."); return; }
  const p = profiles.find((x) => x.id === id);
  if (!confirm(`Delete player "${p.name}" and all of their progress? This cannot be undone.`)) return;
  ["wordStats", "daily", "bestStreak"].forEach((n) => localStorage.removeItem(pkey(n, id)));
  profiles = profiles.filter((x) => x.id !== id);
  saveProfiles();
  if (activeId === id) switchProfile(profiles[0].id);
  renderProfiles();
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- Daily Report ----------
function renderReport() {
  const key = todayKey();
  const d = STORE.daily[key] || { attempts: 0, correct: 0, wrong: 0, mastered: 0, mistakes: [] };
  const p = activeProfile();
  $("reportTitle").textContent = p ? `📊 ${p.avatar} ${p.name}'s Report` : "📊 Daily Report";
  $("reportDate").textContent = prettyDate(new Date());

  const acc = d.attempts ? Math.round((d.correct / d.attempts) * 100) : 0;
  $("todayStats").innerHTML = `
    <div class="stat"><div class="stat-num">${d.attempts}</div><div class="stat-label">words tried</div></div>
    <div class="stat good"><div class="stat-num">${d.correct}</div><div class="stat-label">correct</div></div>
    <div class="stat bad"><div class="stat-num">${d.wrong}</div><div class="stat-label">missed</div></div>
    <div class="stat"><div class="stat-num">${acc}%</div><div class="stat-label">accuracy</div></div>
    <div class="stat star"><div class="stat-num">${d.mastered}</div><div class="stat-label">mastered today</div></div>
  `;

  // Words still to practice (global), with miss counts.
  const tricky = reviewWords()
    .map((w) => ({ word: w.w, wrong: STORE.stats[w.w].wrong, streak: STORE.stats[w.w].streak }))
    .sort((a, b) => b.wrong - a.wrong);
  const tp = $("toPracticeList");
  if (tricky.length) {
    tp.innerHTML = tricky.map((t) =>
      `<div class="tw-row"><span class="tw">${t.word}</span>` +
      `<span class="tw-meta">missed ${t.wrong}× · ${MASTERY_STREAK - t.streak} more to master</span></div>`
    ).join("");
  } else {
    tp.innerHTML = `<div class="all-clear">🎉 No tricky words right now — everything mastered!</div>`;
  }

  // Last 7 days history.
  const rows = [];
  for (let i = 0; i < 7; i++) {
    const dt = new Date(); dt.setDate(dt.getDate() - i);
    const k = todayKey(dt);
    const e = STORE.daily[k];
    if (!e || e.attempts === 0) continue;
    const a = Math.round((e.correct / e.attempts) * 100);
    rows.push(`<div class="hist-row"><span>${shortDate(dt)}</span>` +
      `<span>${e.correct}/${e.attempts} correct</span>` +
      `<span class="hist-acc">${a}%</span></div>`);
  }
  $("historyList").innerHTML = rows.length ? rows.join("") :
    `<div class="all-clear">No practice logged yet this week.</div>`;
}
function prettyDate(d) {
  return d.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
}
function shortDate(d) {
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function clearStats() {
  if (!confirm("Clear ALL of your son's spelling progress and the tricky-words list? This cannot be undone.")) return;
  STORE.stats = {}; STORE.daily = {};
  localStorage.removeItem("bee_wordStats");
  localStorage.removeItem("bee_daily");
  renderReport();
  refreshHome();
}

// ---------- Wiring ----------
function init() {
  ensureProfile();
  loadActiveData();
  fillLevels();
  refreshHome();

  document.querySelectorAll(".mode-btn, .review-btn").forEach((btn) => {
    btn.addEventListener("click", () => startRound(btn.dataset.mode));
  });

  // Profile chip + screen.
  $("profileChip").addEventListener("click", () => show("profiles"));
  $("profilesHomeBtn").addEventListener("click", () => show("home"));
  $("addProfileBtn").addEventListener("click", addProfile);
  $("newProfileName").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addProfile(); } });
  $("profileList").addEventListener("click", (e) => {
    const pick = e.target.closest("[data-pick]");
    const edit = e.target.closest("[data-edit]");
    const del = e.target.closest("[data-del]");
    if (pick) { switchProfile(pick.dataset.pick); show("home"); }
    else if (edit) { renameProfile(edit.dataset.edit); }
    else if (del) { deleteProfile(del.dataset.del); }
  });
  $("avatarRow").addEventListener("click", (e) => {
    const opt = e.target.closest("[data-avatar]");
    if (!opt) return;
    pendingAvatar = opt.dataset.avatar;
    renderProfiles();
  });

  $("speakBtn").addEventListener("click", () => sayWord(0.85));
  $("slowBtn").addEventListener("click", () => sayWord(0.5));

  $("sentenceBtn").addEventListener("click", () => {
    const w = current();
    // In Test/Review the word stays hidden — mask it in BOTH the shown text and the audio.
    const reveal = mode === "practice" || answered;
    $("hintBox").textContent = "💬 " + (reveal ? w.s : maskWord(w.s, w.w, "______"));
    const spoken = reveal ? w.s : maskWord(w.s, w.w, "blank");
    speak(spoken, 0.85);
  });
  $("defineBtn").addEventListener("click", () => {
    const w = current();
    // A definition can mention the word too — mask it while the answer is still hidden.
    const reveal = mode === "practice" || answered;
    $("hintBox").textContent = "📖 " + (reveal ? w.d : maskWord(w.d, w.w, "______"));
    speak(reveal ? w.d : maskWord(w.d, w.w, "this word"), 0.85);
  });

  $("answerForm").addEventListener("submit", (e) => { e.preventDefault(); checkAnswer(); });
  $("nextBtn").addEventListener("click", nextWord);
  $("homeBtn").addEventListener("click", () => show("home"));
  $("againBtn").addEventListener("click", () => startRound(mode));
  $("resultsHomeBtn").addEventListener("click", () => show("home"));

  $("reportBtn").addEventListener("click", () => { renderReport(); show("report"); });
  $("reportHomeBtn").addEventListener("click", () => show("home"));
  $("printBtn").addEventListener("click", () => window.print());
  $("clearStatsBtn").addEventListener("click", clearStats);

  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    navigator.serviceWorker.register("sw.js").then((reg) => reg.update()).catch(() => {});
    // When a new version takes control, refresh once so the latest code loads.
    let refreshed = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (refreshed) return;
      refreshed = true;
      location.reload();
    });
  }
}
document.addEventListener("DOMContentLoaded", init);
