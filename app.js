import Anthropic from "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.132.1/+esm";

const MODEL = "claude-opus-5-5";
const KEY_STORE = "teamx6.apiKey";
const STATE_STORE = "teamx6.state";

const $ = (id) => document.getElementById(id);

// ---------- storage helpers (storage can throw in private windows) ----------
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

// ---------- state ----------
// state.ace: { name, moves[], ability, item, format, goal }
// state.team: [{ name, types[], role, ability, item, moves[] }]   (picks after the ace)
// state.plan: { coach, roles[] } | null   (latest AI suggestions)
let state = load() || { ace: null, team: [], plan: null };

function load() {
  try { return JSON.parse(store.get(STATE_STORE)); } catch { return null; }
}
function save() { store.set(STATE_STORE, JSON.stringify(state)); }

// ---------- sprites ----------
function slug(name) {
  return name.toLowerCase().trim()
    .replace(/♀/g, "-f").replace(/♂/g, "-m")
    .replace(/[é]/g, "e")
    .replace(/[.'’:%]/g, "")
    .replace(/\s+/g, "-");
}
function spriteImg(name, cls = "") {
  const img = new Image();
  img.alt = name;
  if (cls) img.className = cls;
  const s = slug(name);
  const sources = [
    `https://img.pokemondb.net/sprites/home/normal/${s}.png`,
    `https://img.pokemondb.net/sprites/home/normal/${s.split("-")[0]}.png`,
  ];
  let i = 0;
  img.src = sources[i];
  img.onerror = () => {
    i++;
    if (i < sources.length) img.src = sources[i];
    else img.replaceWith(Object.assign(document.createElement("span"), { className: "ball" }));
  };
  return img;
}

// ---------- type colours ----------
const TYPE_COLORS = {
  normal:"#c6c6a7", fire:"#ff8a3d", water:"#4fa3ff", electric:"#ffd93d", grass:"#6fdc5c", ice:"#8fe3f0",
  fighting:"#e05a4f", poison:"#c06be0", ground:"#e0c068", flying:"#a99bff", psychic:"#ff6fa3", bug:"#b8d43a",
  rock:"#c9b45a", ghost:"#8a72c9", dragon:"#7a5cff", dark:"#9a8a7a", steel:"#b8c4d6", fairy:"#ffa6d8",
};
function typeTag(t) {
  const el = document.createElement("span");
  el.className = "tag";
  el.textContent = t;
  const c = TYPE_COLORS[t.toLowerCase()];
  if (c) el.style.setProperty("--tc", c);
  return el;
}

// ---------- dex autocomplete ----------
fetch("https://pokeapi.co/api/v2/pokemon-species?limit=2000")
  .then((r) => r.json())
  .then((d) => {
    const list = $("dex");
    for (const p of d.results) {
      const o = document.createElement("option");
      o.value = p.name.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join("-");
      list.append(o);
    }
  })
  .catch(() => {});

let previewTimer;
$("aceName").addEventListener("input", (e) => {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    const box = $("acePreview");
    box.replaceChildren();
    const v = e.target.value.trim();
    box.append(v ? spriteImg(v) : Object.assign(document.createElement("span"), { className: "ball" }));
  }, 300);
});

// ---------- API key ----------
function getKey() { return store.get(KEY_STORE) || ""; }
function refreshKeyBtn() {
  const btn = $("keyBtn");
  btn.textContent = getKey() ? "API key ✓" : "Add API key";
  btn.classList.toggle("missing", !getKey());
}
function openKeyDialog() {
  $("keyInput").value = getKey();
  $("keyDialog").showModal();
}
$("keyBtn").addEventListener("click", openKeyDialog);
$("keyDialog").addEventListener("close", () => {
  if ($("keyDialog").returnValue === "save") {
    const v = $("keyInput").value.trim();
    v ? store.set(KEY_STORE, v) : store.del(KEY_STORE);
    refreshKeyBtn();
    // pick up where we left off if we were waiting on a key
    if (v && state.ace && !state.plan && state.team.length < 5) replan();
  }
});

// ---------- AI ----------
const PICK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "types", "reason", "ability", "item", "moves"],
  properties: {
    name: { type: "string", description: "Showdown-style species name, e.g. 'Sneasler' or 'Ogerpon-Wellspring'" },
    types: { type: "array", items: { type: "string" } },
    reason: { type: "string", description: "1-2 punchy sentences on why it fits this role and this team" },
    ability: { type: "string" },
    item: { type: "string" },
    moves: { type: "array", items: { type: "string" } },
  },
};
const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["coach", "roles"],
  properties: {
    coach: { type: "string", description: "2-3 sentence coach's note on the team so far and what it still needs" },
    roles: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "why", "picks"],
        properties: {
          title: { type: "string", description: "Short, hype role name, e.g. 'Fast & Furious Attacker'" },
          why: { type: "string", description: "One sentence on what gap this role fills" },
          picks: { type: "array", items: PICK_SCHEMA },
        },
      },
    },
  },
};

const SYSTEM = `You are a competitive Pokémon team-building coach writing for a young, enthusiastic player.
The player gives you their ace Pokémon, its set, the format and what they want the team to do. Over several turns they add teammates one at a time.
Each turn, look at the current team and return the roles still needed to fill the remaining slots (exactly as many roles as open slots), most important first.
For every role give exactly 3 recommended Pokémon that are legal and sensible for the stated format, each with a full set (ability, item, 4 moves).
Never recommend a species already on the team, and avoid duplicate items where the format has Item Clause.
Re-plan the roles every turn based on what has actually been picked: cover new weaknesses the picks created and drop needs they already cover.
Keep the language short, hype and easy to read.`;

function buildPrompt() {
  const a = state.ace;
  const open = 6 - 1 - state.team.length;
  const lines = [
    `Format: ${a.format}`,
    `What I want the team to do: ${a.goal}`,
    ``,
    `Ace: ${a.name}`,
    `  Moves: ${a.moves.join(", ") || "not given"}`,
    a.ability ? `  Ability: ${a.ability}` : null,
    a.item ? `  Item: ${a.item}` : null,
    ``,
    state.team.length ? `Teammates picked so far:` : `No teammates picked yet.`,
    ...state.team.map((m) => `- ${m.name} (role: ${m.role}) — ${m.ability} / ${m.item} / ${m.moves.join(", ")}`),
    ``,
    `Open slots: ${open}. Give me exactly ${open} roles.`,
  ];
  return lines.filter((l) => l !== null).join("\n");
}

async function askCoach() {
  const apiKey = getKey();
  if (!apiKey) {
    openKeyDialog();
    throw new Error("Add your Claude API key to get suggestions.");
  }
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const res = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: {
      effort: "medium",
      format: { type: "json_schema", schema: PLAN_SCHEMA },
    },
    system: SYSTEM,
    messages: [{ role: "user", content: buildPrompt() }],
  });
  if (res.stop_reason === "refusal") throw new Error("The coach couldn't help with that one. Try rewording your goal.");
  if (res.stop_reason === "max_tokens") throw new Error("The answer got cut off. Try again.");
  const text = res.content.find((b) => b.type === "text")?.text;
  if (!text) throw new Error("No answer came back. Try again.");
  return JSON.parse(text);
}

function friendlyError(err) {
  if (err instanceof Anthropic.AuthenticationError) return "That API key didn't work. Check it in the API key settings.";
  if (err instanceof Anthropic.RateLimitError) return "Too many requests right now. Wait a moment and try again.";
  if (err instanceof Anthropic.APIConnectionError) return "Couldn't reach the AI. Check your connection.";
  if (err instanceof Anthropic.APIError) return `The AI returned an error (${err.status}). Try again.`;
  return err.message || String(err);
}

let busy = false;
async function replan() {
  if (busy) return;
  busy = true;
  state.plan = null;
  save();
  render();
  setStatus(`<span class="loader"></span>Scouting the dex for your next teammates…`);
  try {
    state.plan = await askCoach();
    save();
    setStatus("");
  } catch (err) {
    setStatus(`${friendlyError(err)} <button class="btn small ghost" id="retryBtn" type="button">Retry</button>`, true);
    $("retryBtn")?.addEventListener("click", replan);
  } finally {
    busy = false;
    render();
  }
}

function setStatus(html, isErr = false) {
  const s = $("status");
  s.hidden = !html;
  s.innerHTML = html;
  s.classList.toggle("err", isErr);
}

// ---------- actions ----------
$("aceForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const moves = [...document.querySelectorAll('input[name="move"]')].map((i) => i.value.trim()).filter(Boolean);
  state = {
    ace: {
      name: $("aceName").value.trim(),
      moves,
      ability: $("aceAbility").value.trim(),
      item: $("aceItem").value.trim(),
      format: $("format").value,
      goal: $("goal").value.trim(),
    },
    team: [],
    plan: null,
  };
  save();
  replan();
  $("rolesSection").scrollIntoView({ behavior: "smooth", block: "start" });
});

function pick(member) {
  if (busy) return;
  if (state.team.some((m) => slug(m.name) === slug(member.name))) return;
  state.team.push(member);
  save();
  if (state.team.length >= 5) {
    state.plan = null;
    save();
    render();
    $("doneSection").scrollIntoView({ behavior: "smooth", block: "start" });
  } else {
    replan();
  }
}

function removeMember(i) {
  if (busy) return;
  state.team.splice(i, 1);
  save();
  replan();
}

$("resetBtn").addEventListener("click", () => {
  if (busy) return;
  state = { ace: null, team: [], plan: null };
  store.del(STATE_STORE);
  $("aceForm").reset();
  $("acePreview").replaceChildren(Object.assign(document.createElement("span"), { className: "ball" }));
  setStatus("");
  render();
});

$("exportBtn").addEventListener("click", async () => {
  const txt = showdownText();
  try {
    await navigator.clipboard.writeText(txt);
    $("exportBtn").lastChild.textContent = "Copied!";
    setTimeout(() => ($("exportBtn").lastChild.textContent = "Copy Showdown"), 1500);
  } catch {
    $("doneSection").hidden = false;
    $("exportText").textContent = txt;
  }
});

function showdownText() {
  const sets = [];
  if (state.ace) sets.push({ name: state.ace.name, ability: state.ace.ability, item: state.ace.item, moves: state.ace.moves });
  sets.push(...state.team);
  return sets.map((m) => [
    m.item ? `${m.name} @ ${m.item}` : m.name,
    m.ability ? `Ability: ${m.ability}` : null,
    ...m.moves.map((mv) => `- ${mv}`),
  ].filter(Boolean).join("\n")).join("\n\n");
}

// ---------- render ----------
function renderSquad() {
  const ol = $("squad");
  ol.replaceChildren();
  const members = [];
  if (state.ace) members.push({ name: state.ace.name, role: "Ace" });
  members.push(...state.team);
  for (let i = 0; i < 6; i++) {
    const m = members[i];
    const li = document.createElement("li");
    const pg = Object.assign(document.createElement("span"), { className: "pg", textContent: String(i + 1).padStart(2, "0") });
    const mini = Object.assign(document.createElement("span"), { className: "mini" });
    const t = Object.assign(document.createElement("span"), { className: "t" });
    li.append(pg, mini, t);
    if (m) {
      mini.append(spriteImg(m.name));
      t.textContent = m.name;
      t.append(Object.assign(document.createElement("span"), { className: "s", textContent: m.role }));
      if (i > 0) {
        const x = Object.assign(document.createElement("button"), { className: "x", type: "button", textContent: "✕", title: `Remove ${m.name}` });
        x.addEventListener("click", () => removeMember(i - 1));
        li.append(x);
      } else li.append(document.createElement("span"));
    } else {
      li.className = "empty";
      mini.append(Object.assign(document.createElement("span"), { className: "ball" }));
      t.textContent = i === 0 ? "Your ace" : "Open slot";
      li.append(document.createElement("span"));
    }
    ol.append(li);
  }
  $("exportBtn").disabled = !state.ace;
}

function renderRoles() {
  const section = $("rolesSection");
  const wrap = $("roles");
  wrap.replaceChildren();
  const done = state.ace && state.team.length >= 5;
  section.hidden = !state.ace || done;
  $("doneSection").hidden = !done;
  if (done) $("exportText").textContent = showdownText();
  if (!state.ace) return;

  const open = 5 - state.team.length;
  $("slotsLeft").textContent = `${open} slot${open === 1 ? "" : "s"} left · pick one to continue`;

  const coach = $("coach");
  coach.hidden = !state.plan;
  if (state.plan) coach.innerHTML = `<b>Coach's note</b>`, coach.append(state.plan.coach);

  if (!state.plan) return;
  state.plan.roles.forEach((role, ri) => {
    const sec = Object.assign(document.createElement("article"), { className: "role" });
    const head = Object.assign(document.createElement("div"), { className: "role-head" });
    head.append(Object.assign(document.createElement("span"), { className: "role-num", textContent: String(ri + 1).padStart(2, "0") }));
    const ht = document.createElement("div");
    ht.append(Object.assign(document.createElement("h3"), { textContent: role.title }), Object.assign(document.createElement("p"), { textContent: role.why }));
    head.append(ht);
    sec.append(head);

    const grid = Object.assign(document.createElement("div"), { className: "grid" });
    for (const p of role.picks) {
      const card = Object.assign(document.createElement("div"), { className: "card" });
      const art = Object.assign(document.createElement("div"), { className: "card-art" });
      art.append(spriteImg(p.name));
      const body = Object.assign(document.createElement("div"), { className: "card-body" });
      const types = Object.assign(document.createElement("div"), { className: "types" });
      p.types.forEach((t) => types.append(typeTag(t)));
      const set = Object.assign(document.createElement("ul"), { className: "set" });
      p.moves.forEach((mv) => set.append(Object.assign(document.createElement("li"), { textContent: mv })));
      const meta = Object.assign(document.createElement("div"), { className: "meta" });
      meta.innerHTML = `<span><b>Ability</b> </span><span><b>Item</b> </span>`;
      meta.children[0].append(p.ability);
      meta.children[1].append(p.item);
      const btn = Object.assign(document.createElement("button"), { className: "btn small primary", type: "button" });
      btn.innerHTML = `<i>+</i>`;
      btn.append(`Pick ${p.name}`);
      btn.addEventListener("click", () => pick({ name: p.name, types: p.types, role: role.title, ability: p.ability, item: p.item, moves: p.moves }));
      body.append(types, Object.assign(document.createElement("h4"), { textContent: p.name }), Object.assign(document.createElement("p"), { className: "blurb", textContent: p.reason }), set, meta, btn);
      card.append(art, body);
      grid.append(card);
    }
    sec.append(grid);

    // let them choose their own mon for this role
    const custom = Object.assign(document.createElement("form"), { className: "custom" });
    custom.innerHTML = `<span>Or pick your own</span><input list="dex" placeholder="Any Pokémon" required><button class="btn small ghost" type="submit">Use it</button>`;
    custom.addEventListener("submit", (e) => {
      e.preventDefault();
      const name = custom.querySelector("input").value.trim();
      if (name) pick({ name, types: [], role: role.title, ability: "", item: "", moves: [] });
    });
    sec.append(custom);
    wrap.append(sec);
  });
}

function renderTicker() {
  const base = ["Pick your ace", "Tell it what to do", "Fill every role", "Six slots. Zero gaps.", "Copy to Showdown"];
  const names = [state.ace?.name, ...state.team.map((m) => m.name)].filter(Boolean);
  const items = names.length ? [...names.map((n) => `${n} is in`), ...base] : base;
  const track = $("ticker");
  track.replaceChildren();
  for (const t of [...items, ...items]) track.append(Object.assign(document.createElement("span"), { textContent: t }));
}

function render() {
  renderSquad();
  renderRoles();
  renderTicker();
}

// restore form fields from a saved session
if (state.ace) {
  $("aceName").value = state.ace.name;
  document.querySelectorAll('input[name="move"]').forEach((el, i) => (el.value = state.ace.moves[i] || ""));
  $("aceAbility").value = state.ace.ability;
  $("aceItem").value = state.ace.item;
  $("format").value = state.ace.format;
  $("goal").value = state.ace.goal;
  $("acePreview").replaceChildren(spriteImg(state.ace.name));
}
refreshKeyBtn();
render();
if (state.ace && !state.plan && state.team.length < 5) replan();
