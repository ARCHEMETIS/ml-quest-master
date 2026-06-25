// netlify/functions/generate-quest.js
//
// GET  /netlify/functions/generate-quest?level=..&goal=..&time=..&style=..
//   - ดึง progress ล่าสุดจาก Supabase
//   - ถ้ามีเควส "pending" (รูปแบบใหม่) อยู่แล้ว -> คืนอันเดิม (กันสร้างซ้ำตอน refresh)
//   - ถ้าไม่มี -> ให้ Gemini วางเควสตาม roadmap + โปรไฟล์ผู้เรียน แล้วบันทึกลง Supabase
//   - quest มี resources (ลิงก์ Kaggle จริง), steps (ทีละขั้น), deliverable, verify
//   - คืน quest + day + phase + stats (streak, xp รวม, จำนวนเควส, grade)
//
// POST /netlify/functions/generate-quest   { action: "complete" | "skip", progressId }
//   - update สถานะเควส (done + บวก XP / skip) แล้วคืน stats ล่าสุด
//   (รวมไว้ในไฟล์เดียวเพื่อไม่ต้องเปิด SUPABASE_ANON_KEY ออกฝั่ง frontend)

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// free-tier ของ gemini-2.0-flash หมด จึงใช้ 2.5-flash (โควต้าแยกต่อโมเดล + เก่งกว่า)
// ตั้ง env GEMINI_MODEL เพื่อสลับรุ่นได้ (เช่น gemini-2.5-flash-lite ตอนชน limit)
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

// ============================================================
// Roadmap — Kaggle เป็นแกนหลัก (ลิงก์จริง stable ไม่ให้ Gemini มั่ว URL)
// ============================================================
const PHASES = [
  {
    name: "Python & Data Wrangling",
    goal: "ใช้ Python + Pandas โหลด/ทำความสะอาด/วิเคราะห์/visualize ข้อมูลจริงได้คล่อง",
    days: 18,
    courses: [
      { label: "Kaggle Learn: Python", url: "https://www.kaggle.com/learn/python" },
      { label: "Kaggle Learn: Pandas", url: "https://www.kaggle.com/learn/pandas" },
      { label: "Kaggle Learn: Data Cleaning", url: "https://www.kaggle.com/learn/data-cleaning" },
      { label: "Kaggle Learn: Data Visualization", url: "https://www.kaggle.com/learn/data-visualization" },
    ],
    projects: [
      { label: "Titanic — สำรวจ & ทำความสะอาดข้อมูล (EDA)", url: "https://www.kaggle.com/competitions/titanic" },
    ],
  },
  {
    name: "Core ML",
    goal: "เทรน/ปรับจูน/ประเมินโมเดล ML และ submit คะแนนบน Kaggle competition ได้",
    days: 24,
    courses: [
      { label: "Kaggle Learn: Intro to Machine Learning", url: "https://www.kaggle.com/learn/intro-to-machine-learning" },
      { label: "Kaggle Learn: Intermediate Machine Learning", url: "https://www.kaggle.com/learn/intermediate-machine-learning" },
      { label: "Kaggle Learn: Feature Engineering", url: "https://www.kaggle.com/learn/feature-engineering" },
    ],
    projects: [
      { label: "Titanic — submit ครั้งแรก (classification)", url: "https://www.kaggle.com/competitions/titanic" },
      { label: "House Prices — regression", url: "https://www.kaggle.com/competitions/house-prices-advanced-regression-techniques" },
      { label: "Spaceship Titanic", url: "https://www.kaggle.com/competitions/spaceship-titanic" },
    ],
  },
  {
    name: "Deep Learning",
    goal: "สร้าง neural network + งาน Computer Vision / NLP เบื้องต้นด้วย Keras/PyTorch",
    days: 24,
    courses: [
      { label: "Kaggle Learn: Intro to Deep Learning", url: "https://www.kaggle.com/learn/intro-to-deep-learning" },
      { label: "Kaggle Learn: Computer Vision", url: "https://www.kaggle.com/learn/computer-vision" },
    ],
    projects: [
      { label: "Digit Recognizer (MNIST)", url: "https://www.kaggle.com/competitions/digit-recognizer" },
      { label: "NLP — Disaster Tweets", url: "https://www.kaggle.com/competitions/nlp-getting-started" },
    ],
  },
  {
    name: "Specialize & Portfolio",
    goal: "ทำโปรเจค end-to-end ลงพอร์ต + เทคนิคเฉพาะทาง (time series, SQL, model explainability)",
    days: 999,
    courses: [
      { label: "Kaggle Learn: Time Series", url: "https://www.kaggle.com/learn/time-series" },
      { label: "Kaggle Learn: Machine Learning Explainability", url: "https://www.kaggle.com/learn/machine-learning-explainability" },
      { label: "Kaggle Learn: Intro to SQL", url: "https://www.kaggle.com/learn/intro-to-sql" },
      { label: "Kaggle Learn: Advanced SQL", url: "https://www.kaggle.com/learn/advanced-sql" },
    ],
    projects: [
      { label: "เลือก dataset ที่สนใจจาก Kaggle Datasets", url: "https://www.kaggle.com/datasets" },
      { label: "House Prices — ไต่ leaderboard", url: "https://www.kaggle.com/competitions/house-prices-advanced-regression-techniques" },
    ],
  },
];

function phaseForDay(day) {
  let acc = 0;
  for (let i = 0; i < PHASES.length; i++) {
    const start = acc + 1;
    acc += PHASES[i].days;
    if (day <= acc || i === PHASES.length - 1) {
      const within = day - start + 1;
      const span = PHASES[i].days === 999 ? 30 : PHASES[i].days;
      const pct = Math.max(0, Math.min(100, Math.round((within / span) * 100)));
      return {
        index: i,
        number: i + 1,
        total: PHASES.length,
        name: PHASES[i].name,
        goal: PHASES[i].goal,
        courses: PHASES[i].courses,
        projects: PHASES[i].projects,
        next: PHASES[i + 1] ? PHASES[i + 1].name : "Mastery",
        pct,
      };
    }
  }
}

function phaseSpan(i) { return PHASES[i].days === 999 ? 30 : PHASES[i].days; }

// % ความคืบหน้าใน phase = เควสที่ "ทำเสร็จ" ใน phase นั้น / เป้าของ phase (ไม่ใช่เลขวัน)
function phasePct(phaseNumber, doneByPhase) {
  const span = phaseSpan(phaseNumber - 1);
  return Math.min(100, Math.round(((doneByPhase[phaseNumber] || 0) / span) * 100));
}

// สรุปสถานะแต่ละ phase ของ roadmap — status อิง phase ปัจจุบัน, % อิงเควสที่ทำเสร็จ
function buildRoadmap(currentPhaseNumber, doneByPhase = {}, done = []) {
  let acc = 0;
  return PHASES.map((p, i) => {
    const startDay = acc + 1;
    const endDay = p.days === 999 ? null : acc + p.days;
    if (p.days !== 999) acc += p.days;
    const n = i + 1;
    let status = "locked";
    if (n < currentPhaseNumber) status = "done";
    else if (n === currentPhaseNumber) status = "current";
    const pct = status === "done" ? 100 : phasePct(n, doneByPhase);
    return {
      number: n, name: p.name, goal: p.goal,
      startDay, endDay, status, pct,
      courses: p.courses.map((c) => ({ label: c.label, done: done.includes(c.label) })),
      projects: p.projects.map((pr) => ({ label: pr.label })),
    };
  });
}

// ---------- จัดการ rate limit (429) ของ Gemini ----------
function tzOffsetMs(date, tz) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(date).reduce((a, p) => ((a[p.type] = p.value), a), {});
  const asUTC = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUTC - date.getTime();
}
function nextMidnightISO(tz) {
  const now = new Date();
  const off = tzOffsetMs(now, tz);
  const wallNow = new Date(now.getTime() + off);
  const nextWall = Date.UTC(wallNow.getUTCFullYear(), wallNow.getUTCMonth(), wallNow.getUTCDate() + 1, 0, 0, 0);
  return new Date(nextWall - off).toISOString();
}
const nextPacificMidnightISO = () => nextMidnightISO("America/Los_Angeles");

// Supabase คืน created_at เป็น UTC แต่บางทีไม่มี marker timezone -> เติม Z กัน parse ผิด
function parseTs(s) {
  if (typeof s !== "string") return new Date(s);
  return new Date(/(Z|[+-]\d\d:?\d\d)$/.test(s) ? s : s + "Z");
}

// วันที่แบบ "YYYY-MM-DD" ตามโซนเวลาไทย (ใช้ตัดสินว่า "วันนี้" / นับ streak)
const TZ = "Asia/Bangkok";
function localDateStr(d) {
  const off = tzOffsetMs(d, TZ);
  return new Date(d.getTime() + off).toISOString().slice(0, 10);
}
function prevDateStr(s) {
  const [y, m, dd] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, dd - 1)).toISOString().slice(0, 10);
}
function parseRateLimit(bodyText) {
  let detail = null;
  try { detail = JSON.parse(bodyText); } catch {}
  const details = detail?.error?.details || [];
  const violations = details.find((d) => String(d["@type"]).includes("QuotaFailure"))?.violations || [];
  const ids = violations.map((v) => v.quotaId || "").join(" ");
  const isDay = /PerDay/i.test(ids);
  const retryInfo = details.find((d) => String(d["@type"]).includes("RetryInfo"));
  let retryDelaySec = null;
  const m = retryInfo?.retryDelay && String(retryInfo.retryDelay).match(/([\d.]+)s/);
  if (m) retryDelaySec = Math.ceil(parseFloat(m[1]));
  if (isDay) return { quotaType: "day", retryDelaySec, resetAt: nextPacificMidnightISO() };
  return { quotaType: "minute", retryDelaySec, resetAt: new Date(Date.now() + (retryDelaySec || 60) * 1000).toISOString() };
}
function geminiError(status, bodyText) {
  const e = new Error(`Gemini ${status}: ${String(bodyText).slice(0, 200)}`);
  e.status = status;
  if (status === 429) e.rateLimited = parseRateLimit(bodyText);
  return e;
}

// โปรไฟล์ผู้เรียน (ค่า default มาจากที่ผู้ใช้ตอบไว้ตอน onboarding)
function readProfile(qs = {}) {
  return {
    level: qs.level || "เขียน Python ได้บ้าง แต่ยังไม่เคยทำ Machine Learning",
    goal: qs.goal || "ทำพอร์ต/หางาน Data Science + เข้าใจทฤษฎีให้ลึก + ทำโปรเจคของตัวเอง",
    time: qs.time || "เวลาว่างไม่แน่นอน เรียนเป็นช่วง ๆ",
    style: qs.style || "ผสม Kaggle Learn courses + ลงมือทำโปรเจค/dataset จริง",
    // คอร์สที่เรียนจบแล้ว (ข้าม ไม่สั่งซ้ำ) — ส่งมาเป็น label คั่นด้วย ||
    done: qs.done ? String(qs.done).split("||").map((s) => s.trim()).filter(Boolean) : [],
  };
}

// ---------- Supabase REST helper ----------
async function sb(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Supabase ${res.status}: ${txt}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

// ---------- สถิติ ----------
function computeStats(rows) {
  const done = rows.filter((r) => r.status === "done");
  const xp = done.reduce((s, r) => s + (Number(r.xp) || 0), 0);
  const quests = done.length;

  // streak = จำนวน "วันติดต่อกัน" (ตามปฏิทินไทย) ที่มีเควส resolved (done/skip)
  // นับถอยจากวันล่าสุด; ถ้าขาดวันก็หยุด (skip ไม่ทำให้ขาด เพราะยังถือว่ามาเล่น)
  const resolved = rows.filter((r) => r.status === "done" || r.status === "skip");
  const dates = [...new Set(resolved.map((r) => localDateStr(parseTs(r.created_at))))].sort().reverse();
  let streak = 0;
  if (dates.length) {
    const today = localDateStr(new Date());
    // ยอมให้ streak ยังนับได้ถ้าวันล่าสุดคือวันนี้หรือเมื่อวาน (ยังไม่ขาด)
    let expected = dates[0] === today ? today : (dates[0] === prevDateStr(today) ? dates[0] : null);
    if (expected) {
      for (const d of dates) {
        if (d === expected) { streak++; expected = prevDateStr(expected); }
        else break;
      }
    }
  }

  const rate = resolved.length ? done.length / resolved.length : 1;
  let grade = "A";
  if (rate >= 0.95) grade = "A";
  else if (rate >= 0.85) grade = "A−";
  else if (rate >= 0.75) grade = "B+";
  else if (rate >= 0.6) grade = "B";
  else if (rate >= 0.4) grade = "C";
  else grade = "D";

  return { streak, xp, quests, grade };
}

// ---------- Gemini: วางเควสตาม roadmap ----------
async function generateQuest(day, phase, recentTitles, profile) {
  const done = profile.done || [];
  const remainingCourses = phase.courses.filter((c) => !done.includes(c.label));
  const allowed = [...remainingCourses, ...phase.projects];

  const courseList = remainingCourses.length
    ? remainingCourses.map((c) => `- ${c.label} -> ${c.url}`).join("\n")
    : "(เรียนคอร์สใน phase นี้ครบแล้ว — เน้นเควสลงมือทำโปรเจคแทน)";
  const projectList = phase.projects.map((p) => `- ${p.label} -> ${p.url}`).join("\n");
  const doneNote = done.length
    ? `\n[คอร์สที่ผู้เรียนเรียนจบแล้ว — ห้ามสั่งให้เรียน/ทำซ้ำ ให้ข้ามไปหัวข้อถัดไป]\n${done.map((d) => `- ${d}`).join("\n")}`
    : "";

  const avoid = recentTitles.length
    ? `เควสล่าสุดที่เพิ่งทำ (อย่าซ้ำ และให้ต่อยอดเป็นสเต็ปถัดไป): ${recentTitles.join(" | ")}`
    : "นี่คือเควสแรก — เริ่มจากหัวข้อแรกที่ยังไม่ได้เรียนใน phase นี้";

  const prompt = `คุณคือ "ผู้วางแผนการเรียน Machine Learning" ส่วนตัว ออกแบบเควสรายวันให้ผู้เรียนคนนี้โดยใช้ Kaggle เป็นแกนหลัก

[โปรไฟล์ผู้เรียน]
- พื้นฐาน: ${profile.level}
- เป้าหมาย: ${profile.goal}
- เวลาเรียน: ${profile.time}
- สไตล์ที่ชอบ: ${profile.style}

[ตำแหน่งบน roadmap]
- ขณะนี้ Day ${day} อยู่ใน Phase "${phase.name}"
- เป้าหมายของ phase นี้: ${phase.goal}
- ${avoid}

[แหล่งเรียนที่อนุญาตให้ใช้ — ใช้ "URL ตามนี้เป๊ะ ๆ" เท่านั้น ห้ามแต่ง URL ขึ้นเอง]
คอร์ส:
${courseList}
โปรเจค/competition:
${projectList}${doneNote}

[หน้าที่ของคุณ]
ออกแบบ "เควสเดียว" สำหรับครั้งนี้ ให้ชัดเจนจนผู้เรียนเปิดทำตามได้ทันทีโดยไม่ต้องถามต่อ
- สลับระหว่างเควส "เรียนคอร์ส" กับเควส "ลงมือทำโปรเจค/dataset" ให้สมดุล (ผู้เรียนชอบแบบผสม)
- ขนาดเควสกำลังดี ทำจบได้ใน 1 รอบ (เวลาว่างไม่แน่นอน อย่าใหญ่เกินไป)
- steps ต้องบอกชัดว่า "เปิดลิงก์ไหน ทำบทไหน/อะไรบ้าง" เป็นรูปธรรม วัดผลได้
- resources เลือกจากรายการข้างบน 1-2 อัน (ใส่ทั้ง label และ url ตามเป๊ะ)

ตอบกลับเป็น JSON object เท่านั้น (ห้ามมี markdown fence หรือข้อความอื่น) ตาม schema นี้:
{
  "title": "ชื่อเควสสั้นกระชับ",
  "type": "course" | "project",
  "difficulty": "Beginner" | "Intermediate" | "Advanced",
  "time_minutes": 45,
  "xp": 120,
  "description": "อธิบายภาพรวมว่าเควสนี้คืออะไร ทำไปเพื่ออะไร 1-2 ประโยค (ไทย)",
  "resources": [{"label": "ชื่อแหล่ง", "url": "ลิงก์จากรายการข้างบนเท่านั้น"}],
  "steps": ["ขั้นที่ 1 ทำอะไร เปิดลิงก์ไหน (ไทย ละเอียด)", "ขั้นที่ 2 ...", "ขั้นที่ 3 ...", "ขั้นที่ 4 ..."],
  "deliverable": "พอจบต้องได้อะไร เช่น notebook ที่รันได้ / กราฟ / ค่า score ที่ submit แล้ว (ไทย)",
  "verify": "วิธีเช็คด้วยตัวเองว่าทำสำเร็จจริง (ไทย)",
  "tags": ["Tag1", "Tag2"]
}

ข้อกำหนด: steps 4-6 ข้อ, tags 2-3 อัน (อังกฤษสั้น ๆ), time_minutes 30-90, xp 80-180 (ยาก/นานกว่า = สูงกว่า), difficulty เหมาะกับ phase และพื้นฐานผู้เรียน`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.9, responseMimeType: "application/json" },
      }),
    }
  );
  if (!res.ok) throw geminiError(res.status, await res.text());

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
  return normalizeQuest(parseQuestJson(text), allowed);
}

function parseQuestJson(text) {
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start !== -1 && end !== -1) t = t.slice(start, end + 1);
  return JSON.parse(t);
}

function normalizeQuest(q, allowed) {
  const diffs = ["Beginner", "Intermediate", "Advanced"];
  const allowedUrls = (allowed || []).map((r) => r.url);

  // resources: รับเฉพาะ url ที่อยู่ใน allowlist (กัน Gemini แต่ง URL มั่ว / กันคอร์สที่จบแล้ว)
  let resources = Array.isArray(q.resources)
    ? q.resources
        .filter((r) => r && r.url && allowedUrls.includes(r.url))
        .slice(0, 3)
        .map((r) => ({ label: String(r.label || r.url), url: r.url }))
    : [];
  if (!resources.length) {
    const fb = (allowed && allowed[0]) || { label: "Kaggle Learn", url: "https://www.kaggle.com/learn" };
    resources = [{ label: fb.label, url: fb.url }];
  }

  return {
    title: String(q.title || "เควส ML วันนี้").slice(0, 120),
    type: q.type === "project" ? "project" : "course",
    difficulty: diffs.includes(q.difficulty) ? q.difficulty : "Intermediate",
    time_minutes: clampInt(q.time_minutes, 30, 120, 45),
    xp: clampInt(q.xp, 50, 250, 120),
    description: String(q.description || "").slice(0, 400),
    resources,
    steps: Array.isArray(q.steps) ? q.steps.slice(0, 8).map((s) => String(s)) : [],
    deliverable: String(q.deliverable || "").slice(0, 300),
    verify: String(q.verify || "").slice(0, 300),
    tags: Array.isArray(q.tags) ? q.tags.slice(0, 4).map((s) => String(s)) : [],
  };
}

function clampInt(v, min, max, def) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return def;
  return Math.max(min, Math.min(max, n));
}

function json(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

// ---------- handler ----------
exports.handler = async (event) => {
  try {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !GEMINI_API_KEY) {
      return json(500, {
        error: "Missing env vars (SUPABASE_URL, SUPABASE_ANON_KEY, GEMINI_API_KEY)",
      });
    }

    // ----- POST: complete / skip -----
    if (event.httpMethod === "POST") {
      const body = JSON.parse(event.body || "{}");
      const { action, progressId } = body;
      if (!progressId || !["complete", "skip"].includes(action)) {
        return json(400, { error: "ต้องระบุ progressId และ action (complete|skip)" });
      }
      const target = await sb(`progress?id=eq.${progressId}&select=*`);
      if (!target.length) return json(404, { error: "ไม่พบเควส" });
      const row = target[0];
      // กันตัดสินซ้ำ (idempotent) — ถ้าไม่ pending แล้ว คืน stats เฉย ๆ
      if (row.status !== "pending") {
        return json(409, { error: "เควสนี้ถูกตัดสินไปแล้ว", stats: computeStats(await sb(`progress?select=*&order=day.desc`)) });
      }
      // complete: ตรวจว่าทำ checklist ครบจริง (กันกดลัด) — เทียบกับจำนวน steps ที่เก็บไว้
      if (action === "complete") {
        let total = 0;
        try { total = (JSON.parse(row.quest_text).steps || []).length; } catch {}
        const stepsDone = Number(body.steps_done) || 0;
        if (total > 0 && stepsDone < total) {
          return json(400, { error: "ยังทำ checklist ไม่ครบทุกขั้นตอน" });
        }
      }
      const patch =
        action === "complete" ? { status: "done", xp: row.xp } : { status: "skip", xp: 0 };
      await sb(`progress?id=eq.${progressId}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify(patch),
      });
      const rows = await sb(`progress?select=*&order=day.desc`);
      return json(200, { ok: true, stats: computeStats(rows) });
    }

    // ----- GET: ดึง/สร้างเควส -----
    const qs = event.queryStringParameters || {};
    const fresh = qs.fresh === "1"; // บังคับสร้างใหม่ (เช่น หลังเปลี่ยนโปรไฟล์)
    const profile = readProfile(qs);
    const rows = await sb(`progress?select=*&order=day.desc`);
    const top = rows[0];

    const doneCount = rows.filter((r) => r.status === "done").length;
    const position = doneCount + 1; // ตำแหน่งบน roadmap อิง "เควสที่ทำเสร็จ" ไม่ใช่เลขลำดับ (#2)
    const todayStr = localDateStr(new Date());

    // % / สถานะ roadmap อิงจำนวนที่ทำเสร็จต่อ phase
    const doneByPhase = {};
    rows.forEach((r) => { if (r.status === "done") doneByPhase[r.phase] = (doneByPhase[r.phase] || 0) + 1; });

    // สร้างเควสใหม่ + insert (กัน day ซ้ำตอนยิงพร้อมกัน #5)
    async function createQuest(phaseObj) {
      const seq = (rows[0] ? rows[0].day : 0) + 1; // เลขลำดับใน DB (monotonic, ไว้ order)
      const recentTitles = rows.slice(0, 5)
        .map((r) => { try { return JSON.parse(r.quest_text).title; } catch { return null; } })
        .filter(Boolean);
      const q = await generateQuest(position, phaseObj, recentTitles, profile);
      try {
        const inserted = await sb(`progress`, {
          method: "POST",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({
            day: seq, phase: phaseObj.number, topic: q.title,
            quest_text: JSON.stringify(q), status: "pending", xp: q.xp,
          }),
        });
        return inserted[0];
      } catch (e) {
        // race: day ซ้ำ (unique constraint) -> ใช้เควส pending ที่อีก request สร้างไว้แทน
        const exist = await sb(`progress?day=eq.${seq}&select=*`);
        if (exist.length) return exist[0];
        throw e;
      }
    }

    let day = position, quest, progressId, status = "pending";
    let lockedUntilTomorrow = false, nextResetAt = null;
    const phase = phaseForDay(position);

    // เควส pending รูปแบบใหม่ (ยังทำไม่เสร็จ) -> ใช้ต่อ (carry over ข้ามวันได้)
    let reusable = null;
    if (!fresh && top && top.status === "pending" && top.quest_text) {
      try {
        const q = JSON.parse(top.quest_text);
        if (q && q.title && Array.isArray(q.steps) && q.steps.length) reusable = normalizeQuest(q, q.resources || []);
      } catch { reusable = null; }
    }

    // เควสวันนี้ที่ resolved แล้ว (เปิด parse ได้) -> ใช้ล็อกถึงพรุ่งนี้
    let lockedQuest = null;
    if (top && (top.status === "done" || top.status === "skip") &&
        localDateStr(parseTs(top.created_at)) === todayStr) {
      try { lockedQuest = normalizeQuest(JSON.parse(top.quest_text), JSON.parse(top.quest_text).resources || []); } catch { lockedQuest = null; }
    }

    if (reusable) {
      quest = reusable; progressId = top.id;
    } else if (top && top.status === "pending") {
      // pending เสีย/เก่า หรือสั่ง fresh -> ลบแล้วสร้างแทน (ตำแหน่งเดิม ไม่ใช่วันใหม่)
      await sb(`progress?id=eq.${top.id}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
      rows.shift();
      const r = await createQuest(phase);
      progressId = r.id; quest = JSON.parse(r.quest_text); // เก็บแบบ normalize แล้ว
    } else if (lockedQuest) {
      // ทำเควสของวันนี้ไปแล้ว -> ล็อกจนถึงพรุ่งนี้ (#1 บังคับ 1 เควส/วัน + กัน quota)
      quest = lockedQuest; progressId = top.id; status = top.status;
      lockedUntilTomorrow = true; nextResetAt = nextMidnightISO(TZ);
    } else {
      // ไม่มีเควส หรือเควสล่าสุด resolved ของวันก่อน -> สร้างเควสของวันนี้
      const r = await createQuest(phase);
      progressId = r.id; quest = JSON.parse(r.quest_text); // เก็บแบบ normalize แล้ว
    }

    phase.pct = phasePct(phase.number, doneByPhase);

    return json(200, {
      day, phase, progressId, quest, profile, status, lockedUntilTomorrow, nextResetAt,
      roadmap: buildRoadmap(phase.number, doneByPhase, profile.done),
      stats: computeStats(rows),
    });
  } catch (err) {
    if (err.rateLimited) {
      return json(429, {
        error: "ใช้โควต้า Gemini ฟรีครบแล้ว",
        rateLimited: err.rateLimited,
      });
    }
    return json(500, { error: String(err.message || err) });
  }
};
