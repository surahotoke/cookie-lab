import { Hono } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { DurableObject, waitUntil } from 'cloudflare:workers'
import { Kysely, sql } from 'kysely'
import { D1Dialect } from 'kysely-d1'

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WEEK = 7 * DAY

const app = new Hono<{ Bindings: Env }>()

app.get('/', async (c) => {
  const last = getCookie(c, 'last')
  let streak = Number(getCookie(c, 'streak') ?? 0)
  let max = Number(getCookie(c, 'max') ?? 0)

  // --- 今日・昨日の日付 ---
  const tz = (c.req.raw.cf?.timezone as string) ?? 'Asia/Tokyo'
  const fmt = new Intl.DateTimeFormat('sv-SE', { timeZone: tz })
  const toDate = (ms: number) => fmt.format(ms)

  const now = Date.now()
  const today = toDate(now)
  const yesterday = toDate(now - DAY)

  // --- 連続日数の判定 ---
  if (last === today) {
    // 据え置き
  } else if (last === yesterday) {
    streak += 1
  } else {
    streak = 1
  }
  if (streak > max) max = streak

  // --- 全員合計(DO)---
  const totalPromise = c.env.TOTAL.getByName('global').increment()

  // --- 昨日/先週の訪問数(KV)---
  const yesterdayCount = Number((await c.env.KV.get('yesterday')) ?? 0)
  const lastWeekCount = Number((await c.env.KV.get('lastWeek')) ?? 0)

  // --- 訪問を記録(D1)---
  const { startOfToday, startOfWeek } = jstBoundaries(now)
  const db = getDb(c.env.DB)
  await sql`INSERT INTO visits (time) VALUES (${now})`.execute(db)

  // --- 直近5分/20分/1時間/今日/今週の訪問数(D1)---
  const result = await sql<{ m5: number; m20: number; h1: number; today: number; week: number }>`
    SELECT
      COUNT(*) FILTER (WHERE time >= ${now - 5 * MINUTE}) AS m5,
      COUNT(*) FILTER (WHERE time >= ${now - 20 * MINUTE}) AS m20,
      COUNT(*) FILTER (WHERE time >= ${now - HOUR}) AS h1,
      COUNT(*) FILTER (WHERE time >= ${startOfToday}) AS today,
      COUNT(*) FILTER (WHERE time >= ${startOfWeek}) AS week
    FROM visits
  `.execute(db)

  const row = result.rows[0]

  const m5 = row?.m5 ?? 0
  const m20 = row?.m20 ?? 0
  const h1 = row?.h1 ?? 0
  const todayCount = row?.today ?? 0
  const weekCount = row?.week ?? 0

  // --- 古い行の掃除(3週間より前を削除)---
  waitUntil(sql`DELETE FROM visits WHERE time < ${now - 3 * WEEK}`.execute(db))

  // 全員合計
  const total = await totalPromise

  // --- SVG ---
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="520" height="84"><text x="0" y="22" font-size="18">連続 ${streak}日 / 最長 ${max}日 / 全員合計: ${total}</text><text x="0" y="48" font-size="18">直近 5分:${m5} / 20分:${m20} / 1時間:${h1}</text><text x="0" y="74" font-size="18">今日:${todayCount} (昨日:${yesterdayCount}) / 今週:${weekCount} (先週:${lastWeekCount})</text></svg>`

  // --- ヘッダ + Cookie ---
  c.header('content-type', 'image/svg+xml')
  c.header('cache-control', 'no-store')
  const opt = { sameSite: 'None', secure: true, maxAge: 34560000, path: '/' } as const
  setCookie(c, 'last', today, opt)
  setCookie(c, 'streak', String(streak), opt)
  setCookie(c, 'max', String(max), opt)

  return c.body(svg)
})

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env) {
    switch (event.cron) {
      case '0 15 * * SUN':
        await bakeLastWeek(env, event.scheduledTime)
        break
      case '0 15 * * *':
        await bakeYesterday(env, event.scheduledTime)
        break
    }
  },
}

export class Total extends DurableObject {
  async increment(): Promise<number> {
    const current = (await this.ctx.storage.get<number>('total')) ?? 0
    const next = current + 1
    await this.ctx.storage.put('total', next)
    return next
  }
  async resetTotal(): Promise<number> {
    const db = getDb(this.env.DB)
    const { rows } = await sql<{ c: number }>`SELECT COUNT(*) AS c FROM visits`.execute(db)
    const count = rows[0]?.c ?? 0
    await this.ctx.storage.put('total', count)
    return count
  }
}

const reset = new Hono<{ Bindings: Env }>()
reset.get('/total', async (c) => {
  const total = await c.env.TOTAL.getByName('global').resetTotal()
  return c.json({ total })
})

// これまで設定したreset系を一括でセット
app.route('/reset', reset)

// --- 共通ヘルパ ---

// D1 から Kysely インスタンスを生成
function getDb(database: D1Database): Kysely<any> {
  return new Kysely({ dialect: new D1Dialect({ database }) })
}

// JST基準の「今日の0時」「今週(月曜)の0時」をまとめて返す
function jstBoundaries(now: number): { startOfToday: number; startOfWeek: number } {
  const todayJST = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(now)
  const startOfToday = Date.parse(`${todayJST}T00:00:00+09:00`)
  const dayOfWeek = new Date(todayJST).getUTCDay()
  const sinceMonday = (dayOfWeek + 6) % 7
  const startOfWeek = startOfToday - sinceMonday * DAY
  return { startOfToday, startOfWeek }
}

// [from, to) の訪問数を数える
async function countVisits(db: Kysely<any>, from: number, to: number): Promise<number> {
  const result = await sql<{ count: number }>`
    SELECT COUNT(*) FILTER (WHERE time >= ${from} AND time < ${to}) AS count
    FROM visits
  `.execute(db)
  return result.rows[0]?.count ?? 0
}

// [from, to) の訪問数を数えて KV に焼く
async function bakeCount(env: Env, key: string, from: number, to: number): Promise<void> {
  const db = getDb(env.DB)
  const count = await countVisits(db, from, to)
  await env.KV.put(key, String(count))
}

async function bakeYesterday(env: Env, now: number): Promise<void> {
  const { startOfToday } = jstBoundaries(now)
  await bakeCount(env, 'yesterday', startOfToday - DAY, startOfToday)
}

async function bakeLastWeek(env: Env, now: number): Promise<void> {
  const { startOfWeek } = jstBoundaries(now)
  await bakeCount(env, 'lastWeek', startOfWeek - WEEK, startOfWeek)
}
