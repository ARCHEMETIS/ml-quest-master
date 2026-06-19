// netlify/functions/chat.js
//
// POST /netlify/functions/chat
//   body: { question, questContext, history, progressId }
//   - ส่งให้ Gemini 2.0 Flash ตอบเป็น "Quest Coach" ภาษาไทย กระชับ มี code ถ้าจำเป็น
//   - (ออปชัน) บันทึกลง chat_history ถ้ามี progressId

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// free-tier quota ของ gemini-2.0-flash หมด จึงใช้ 2.5-flash (โควต้าแยกต่อโมเดล + เก่งกว่า)
// ตั้ง env GEMINI_MODEL เพื่อสลับรุ่นได้ (เช่น gemini-2.5-flash-lite ตอนชน limit)
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

// ---------- rate limit (429) ----------
function tzOffsetMs(date, tz) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(date).reduce((a, p) => ((a[p.type] = p.value), a), {});
  const asUTC = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUTC - date.getTime();
}
function nextPacificMidnightISO() {
  const now = new Date();
  const off = tzOffsetMs(now, "America/Los_Angeles");
  const wallNow = new Date(now.getTime() + off);
  const nextWall = Date.UTC(wallNow.getUTCFullYear(), wallNow.getUTCMonth(), wallNow.getUTCDate() + 1, 0, 0, 0);
  return new Date(nextWall - off).toISOString();
}
function parseRateLimit(bodyText) {
  let detail = null;
  try { detail = JSON.parse(bodyText); } catch {}
  const details = detail?.error?.details || [];
  const violations = details.find((d) => String(d["@type"]).includes("QuotaFailure"))?.violations || [];
  const isDay = /PerDay/i.test(violations.map((v) => v.quotaId || "").join(" "));
  const retryInfo = details.find((d) => String(d["@type"]).includes("RetryInfo"));
  let retryDelaySec = null;
  const m = retryInfo?.retryDelay && String(retryInfo.retryDelay).match(/([\d.]+)s/);
  if (m) retryDelaySec = Math.ceil(parseFloat(m[1]));
  if (isDay) return { quotaType: "day", retryDelaySec, resetAt: nextPacificMidnightISO() };
  return { quotaType: "minute", retryDelaySec, resetAt: new Date(Date.now() + (retryDelaySec || 60) * 1000).toISOString() };
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function saveChat(progressId, role, message) {
  if (!progressId) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/chat_history`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ progress_id: progressId, role, message }),
    });
  } catch (_) {
    // บันทึกไม่สำเร็จไม่ถือว่า error หลัก
  }
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { error: "Method not allowed" });
    }
    if (!GEMINI_API_KEY) {
      return json(500, { error: "Missing GEMINI_API_KEY" });
    }

    const body = JSON.parse(event.body || "{}");
    const question = (body.question || "").trim();
    const questContext = body.questContext || null;
    const history = Array.isArray(body.history) ? body.history : [];
    const progressId = body.progressId || null;

    if (!question) return json(400, { error: "ต้องมี question" });

    // ----- system instruction -----
    let ctx = "";
    if (questContext) {
      const steps = (questContext.steps || questContext.objectives || []).join("; ");
      const res = (questContext.resources || [])
        .map((r) => `${r.label} (${r.url})`)
        .join(", ");
      ctx = `\n\nบริบทเควสของผู้เรียนตอนนี้:
- หัวข้อ: ${questContext.title || "-"}
- ระดับ: ${questContext.difficulty || "-"}
- รายละเอียด: ${questContext.description || "-"}
- ขั้นตอนที่ต้องทำ: ${steps || "-"}
- แหล่งเรียน: ${res || "-"}
- Phase: ${questContext.phase || "-"}`;
    }

    const systemPrompt = `คุณคือ "Quest Coach" โค้ช Machine Learning ที่อบอุ่น เก่ง และให้กำลังใจ อยู่ในแอปเรียน ML แบบเควสรายวัน
ตอบเป็น "ภาษาไทย" เสมอ กระชับ ตรงประเด็น เข้าใจง่าย
เน้นการให้ "ใบ้/คำชี้แนะ (hint)" และตั้งคำถามกระตุ้นความคิด มากกว่าเฉลยทั้งหมด ยกเว้นผู้เรียนขอเฉลยตรง ๆ
ใส่โค้ดตัวอย่าง (Python/NumPy/PyTorch) เฉพาะเมื่อจำเป็น โดยใส่ใน code block
ความยาวคำตอบไม่ควรเกิน ~150 คำ ใช้ย่อหน้าสั้น ๆ ไม่ต้องใส่หัวข้อใหญ่${ctx}`;

    // ----- แปลง history เป็น contents ของ Gemini -----
    const contents = [];
    for (const m of history.slice(-12)) {
      if (!m || !m.content) continue;
      contents.push({
        role: m.role === "user" ? "user" : "model",
        parts: [{ text: String(m.content) }],
      });
    }
    contents.push({ role: "user", parts: [{ text: question }] });

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents,
          generationConfig: { temperature: 0.7, maxOutputTokens: 800 },
        }),
      }
    );

    if (!res.ok) {
      const txt = await res.text();
      if (res.status === 429) {
        return json(429, { error: "ใช้โควต้า Gemini ฟรีครบแล้ว", rateLimited: parseRateLimit(txt) });
      }
      throw new Error(`Gemini ${res.status}: ${txt}`);
    }

    const data = await res.json();
    const reply =
      data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("").trim() ||
      "ขอโทษครับ ตอนนี้นึกไม่ออก ลองถามใหม่อีกครั้งได้ไหมครับ?";

    // บันทึกประวัติแชต (ไม่ block ผลลัพธ์)
    await saveChat(progressId, "user", question);
    await saveChat(progressId, "assistant", reply);

    return json(200, { reply });
  } catch (err) {
    return json(500, { error: String(err.message || err) });
  }
};
