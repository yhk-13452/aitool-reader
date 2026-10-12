import { fmtDuration } from '../lib/reading.js'

// 只有「年」这一层可切换；月和每本书的时长都平铺在年页面里，不再做多级下钻。
export default function ReadingStats({ data, year, onYear }) {
    const step = delta => onYear(year + delta)
    // 用箭头翻到的年份本身没有记录，也要出现在按钮里，否则选中态没处显示
    const years = [...new Set([year, ...(data?.years ?? [])])].sort((a, b) => b - a)

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

        <ul className="stats-months">
            {(data?.months ?? []).map(m => <li key={m.month}>
                <div className="stats-month">
                    <strong>{m.month} 月</strong>
                    <span className="note">{m.ms ? fmtDuration(m.ms) : '没读'}</span>
                </div>
                {m.books.length > 0 && <ul className="stats-books">
                    {m.books.map(b => <li key={b.id}>
                        <span className="stats-book-name">{b.name}</span>
                        <span className="note">{fmtDuration(b.ms)}</span>
                    </li>)}
                </ul>}
            </li>)}
        </ul>

        <p className="note">
            计时只在书页开着、且这个页面在前台可见时累计；回书架、切走 App、打开自检浮层都不计入。
            统计只覆盖当前书架上的书 —— <strong>把书移出书架时，它的阅读时长记录会一并删除</strong>。
        </p>
    </section>
}
