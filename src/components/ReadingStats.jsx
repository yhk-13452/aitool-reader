import { useState } from 'react'
import { fmtDuration } from '../lib/reading.js'

// 只有「年」这一层可切换；月与周都平铺在年页面里，点开某月才摊到那一月的各周。
// 周按周一起算，跨月的那一周只计落在本月的那几天 —— 所以区间标签会被截断（如 10-26–10-31），
// 这不是显示残缺：把某月的几周加起来必须正好等于那个月的合计，口径才对得上。
export default function ReadingStats({ data, year, onYear, allTime }) {
    const [open, setOpen] = useState(null)
    const step = delta => onYear(year + delta)
    // 用箭头翻到的年份本身没有记录，也要出现在按钮里，否则选中态没处显示
    const years = [...new Set([year, ...(data?.years ?? [])])].sort((a, b) => b - a)
    const toggle = m => setOpen(open === m ? null : m)

    return <section className="stats">
        <header className="stats-head">
            <h2>{year} 年阅读时长</h2>
            <span className="note">全年合计 {data ? fmtDuration(data.total) : '统计中…'}</span>
            <span className="year-pick">
                <button className="btn" onClick={() => step(-1)}>◀</button>
                {years.map(y => <button key={y}
                    className={`btn${y === year ? ' on' : ''}`}
                    onClick={() => onYear(y)}>{y}</button>)}
                <button className="btn" onClick={() => step(1)}>▶</button>
            </span>
        </header>

        {data && data.books.length > 0 && <div className="stats-year-books">
            <strong>按书合计（{year} 年）</strong>
            <ul className="stats-books">
                {data.books.map(b => <li key={b.id}>
                    <span className="stats-book-name">{b.name}</span>
                    <span className="note">{fmtDuration(b.ms)}</span>
                </li>)}
            </ul>
        </div>}

        {allTime?.length > 0 && <div className="stats-year-books">
            <strong>按书合计（全部时间）</strong>
            <ul className="stats-books">
                {allTime.map(b => <li key={b.id}>
                    <span className="stats-book-name">{b.name}</span>
                    <span className="note">{fmtDuration(b.ms)}</span>
                </li>)}
            </ul>
        </div>}

        <ul className="stats-months">
            {(data?.months ?? []).map(m => <li key={m.month}>
                <button className="stats-month" disabled={!m.ms} onClick={() => toggle(m.month)}>
                    <strong>{m.month} 月</strong>
                    <span className="note">{m.ms ? `${fmtDuration(m.ms)}${open === m.month ? ' ▾' : ' ▸'}` : '没读'}</span>
                </button>
                {m.books.length > 0 && <ul className="stats-books">
                    {m.books.map(b => <li key={b.id}>
                        <span className="stats-book-name">{b.name}</span>
                        <span className="note">{fmtDuration(b.ms)}</span>
                    </li>)}
                </ul>}
                {open === m.month && <ul className="stats-weeks">
                    {m.weeks.map(w => <li key={w.start}>
                        <div className="stats-week-head">
                            <span className="stats-week-label">{w.label}</span>
                            <span className="note">{fmtDuration(w.ms)}</span>
                        </div>
                        <ul className="stats-books">
                            {w.books.map(b => <li key={b.id}>
                                <span className="stats-book-name">{b.name}</span>
                                <span className="note">{fmtDuration(b.ms)}</span>
                            </li>)}
                        </ul>
                    </li>)}
                </ul>}
            </li>)}
        </ul>

        <p className="note">
            计时只在书页开着、且这个页面在前台可见时累计；回书架、切走 App、打开自检浮层都不计入。
            点某个月会摊开那个月的每一周（按周一起算，跨月的一周只计本月那几天）。
            统计只覆盖当前书架上的书 —— <strong>把书移出书架时，它的阅读时长记录会一并删除</strong>。
        </p>
    </section>
}
