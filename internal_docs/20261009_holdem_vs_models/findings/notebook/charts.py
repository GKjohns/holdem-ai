"""Inline-SVG chart helpers for the B5 report. Every color is a CSS custom property from the
report's token set, so charts follow the page's light/dark theme. Native <title> tooltips give a
hover layer without script."""
import html

esc = html.escape
MODEL_VAR = {'Sol': '--m-sol', 'Luna': '--m-luna', 'Luna Decisions': '--m-lunad', 'Haiku': '--m-haiku', 'Jev': '--m-jev'}


def _scale(d0, d1, r0, r1):
    return lambda v: r0 + (v - d0) * (r1 - r0) / (d1 - d0)


def ci_dots(rows, domain, ticks, unit='bb/100', label_w=128, width=640, row_h=40, note=None):
    """rows: (label, value, lo, hi, sublabel). Horizontal dot + 95% CI whisker with a zero line."""
    top, bottom = 10, 48
    h = top + bottom + row_h * len(rows)
    x = _scale(domain[0], domain[1], label_w + 8, width - 56)
    out = [f'<svg viewBox="0 0 {width} {h}" class="chart" role="img" aria-label="{esc(unit)} with 95% confidence intervals">']
    for t in ticks:
        out.append(f'<line x1="{x(t):.1f}" x2="{x(t):.1f}" y1="{top}" y2="{h - bottom + 4}" class="{"zero" if t == 0 else "grid"}"/>')
        out.append(f'<text x="{x(t):.1f}" y="{h - bottom + 20}" class="tick" text-anchor="middle">{t:+d}</text>' if t else f'<text x="{x(t):.1f}" y="{h - bottom + 20}" class="tick" text-anchor="middle">0</text>')
    out.append(f'<text x="{label_w + 8}" y="{h - 4}" class="axis-label">{esc(unit)}</text>')
    for i, (lab, v, lo, hi, sub) in enumerate(rows):
        cy = top + row_h * i + row_h / 2
        var = MODEL_VAR.get(lab, '--ink-2')
        out.append(f'<g><title>{esc(lab)}: {v:+.0f} [{lo:+.0f}, {hi:+.0f}] {esc(unit)}</title>')
        out.append(f'<text x="0" y="{cy - 2:.1f}" class="row-label">{esc(lab)}</text>')
        if sub:
            out.append(f'<text x="0" y="{cy + 13:.1f}" class="row-sub">{esc(sub)}</text>')
        out.append(f'<rect x="{x(lo):.1f}" y="{cy - 5:.1f}" width="{max(2, x(hi) - x(lo)):.1f}" height="10" rx="5" style="fill:var({var});opacity:.22"/>')
        out.append(f'<line x1="{x(lo):.1f}" x2="{x(hi):.1f}" y1="{cy:.1f}" y2="{cy:.1f}" style="stroke:var({var})" stroke-width="2"/>')
        out.append(f'<circle cx="{x(v):.1f}" cy="{cy:.1f}" r="6" style="fill:var({var})" class="ring"/>')
        out.append(f'<text x="{min(x(hi), width - 60) + 10:.1f}" y="{cy + 4:.1f}" class="val">{v:+.0f}</text></g>')
    out.append('</svg>')
    return '\n'.join(out)


def hbars(rows, domain, ticks, unit, label_w=150, width=640, row_h=30, fmt='{:+.0f}', color=None):
    """rows: (label, value, tooltip). Diverging-from-zero bars, direct value labels."""
    top, bottom = 6, 44
    h = top + bottom + row_h * len(rows)
    x = _scale(domain[0], domain[1], label_w + 8, width - 48)
    out = [f'<svg viewBox="0 0 {width} {h}" class="chart" role="img" aria-label="{esc(unit)}">']
    for t in ticks:
        out.append(f'<line x1="{x(t):.1f}" x2="{x(t):.1f}" y1="{top}" y2="{h - bottom + 4}" class="{"zero" if t == 0 else "grid"}"/>')
        out.append(f'<text x="{x(t):.1f}" y="{h - bottom + 20}" class="tick" text-anchor="middle">{t:g}</text>')
    out.append(f'<text x="{label_w + 8}" y="{h - 4}" class="axis-label">{esc(unit)}</text>')
    for i, (lab, v, tip) in enumerate(rows):
        cy = top + row_h * i + row_h / 2
        base = lab.split(' · ')[0]
        var = color or MODEL_VAR.get(base, '--ink-2')
        x0, x1 = sorted((x(0 if domain[0] < 0 else domain[0]), x(v)))
        out.append(f'<g><title>{esc(tip)}</title><text x="0" y="{cy + 4:.1f}" class="row-label">{esc(lab)}</text>')
        out.append(f'<rect x="{x0:.1f}" y="{cy - 8:.1f}" width="{max(2, x1 - x0):.1f}" height="16" rx="3" style="fill:var({var})"/>')
        tx = x1 + 6 if v >= 0 else x0 - 6
        out.append(f'<text x="{tx:.1f}" y="{cy + 4:.1f}" class="val" text-anchor="{"start" if v >= 0 else "end"}">{fmt.format(v)}</text></g>')
    out.append('</svg>')
    return '\n'.join(out)


def stacked_share(rows, cats, unit, label_w=128, width=640, row_h=30):
    """rows: (label, [counts per cat]). 100% stacked bars; cat colors are a sequential ink ramp."""
    top, bottom = 26, 8
    h = top + bottom + row_h * len(rows)
    x = _scale(0, 1, label_w + 8, width - 8)
    n = len(cats)
    out = [f'<svg viewBox="0 0 {width} {h}" class="chart" role="img" aria-label="{esc(unit)}">']
    for j, c in enumerate(cats):
        lx = x(j / n)
        out.append(f'<rect x="{lx:.1f}" y="4" width="12" height="12" rx="2" style="fill:color-mix(in oklab, var(--accent) {100 - j * 80 // max(1, n - 1)}%, var(--bg))"/>')
        out.append(f'<text x="{lx + 16:.1f}" y="14" class="tick">{esc(c)}</text>')
    for i, (lab, counts) in enumerate(rows):
        cy = top + row_h * i + row_h / 2
        tot = sum(counts)
        out.append(f'<text x="0" y="{cy + 4:.1f}" class="row-label">{esc(lab)}</text>')
        acc = 0
        for j, c in enumerate(counts):
            if not c:
                continue
            x0, x1 = x(acc / tot), x((acc + c) / tot)
            mix = 100 - j * 80 // max(1, n - 1)
            out.append(f'<g><title>{esc(lab)}: {esc(cats[j])} in {c} of {tot}</title><rect x="{x0 + 1:.1f}" y="{cy - 9:.1f}" width="{max(1, x1 - x0 - 2):.1f}" height="18" rx="2" style="fill:color-mix(in oklab, var(--accent) {mix}%, var(--bg))"/>')
            if x1 - x0 > 18:
                out.append(f'<text x="{(x0 + x1) / 2:.1f}" y="{cy + 4:.1f}" class="in-bar {"dark" if mix > 55 else ""}" text-anchor="middle">{c}</text>')
            out.append('</g>')
            acc += c
    out.append('</svg>')
    return '\n'.join(out)


def lines(series, xlabels, domain, ticks, unit, ref=None, width=640, height=300, label_w=0, right=118):
    """series: (label, [y...]). ref: (label, [y...]) drawn dashed in muted ink. Direct labels at the right end."""
    left, top, bottom = 44, 12, 36
    xs = _scale(0, len(xlabels) - 1, left + 10, width - right)
    y = _scale(domain[0], domain[1], height - bottom, top)
    out = [f'<svg viewBox="0 0 {width} {height}" class="chart" role="img" aria-label="{esc(unit)}">']
    for t in ticks:
        out.append(f'<line x1="{left}" x2="{width - right + 10}" y1="{y(t):.1f}" y2="{y(t):.1f}" class="grid"/><text x="{left - 6}" y="{y(t) + 4:.1f}" class="tick" text-anchor="end">{t:g}</text>')
    for i, l in enumerate(xlabels):
        out.append(f'<text x="{xs(i):.1f}" y="{height - bottom + 18}" class="tick" text-anchor="middle">{esc(l)}</text>')
    out.append(f'<text x="{left}" y="{height - 2}" class="axis-label">{esc(unit)}</text>')
    if ref:
        pts = ' '.join(f'{xs(i):.1f},{y(v):.1f}' for i, v in enumerate(ref[1]))
        out.append(f'<polyline points="{pts}" class="ref-line"/><text x="{xs(0) + 4:.1f}" y="{y(ref[1][0]) + 16:.1f}" class="ref-label">{esc(ref[0])}</text>')
    # place end labels without collisions
    ends = sorted([(y(vals[-1]), lab) for lab, vals in series], key=lambda t: t[0])
    placed = []
    for yy, lab in ends:
        if placed and yy - placed[-1][0] < 14:
            yy = placed[-1][0] + 14
        placed.append((yy, lab))
    endpos = {lab: yy for yy, lab in placed}
    for lab, vals in series:
        var = MODEL_VAR.get(lab, '--ink-2')
        pts = ' '.join(f'{xs(i):.1f},{y(v):.1f}' for i, v in enumerate(vals))
        out.append(f'<polyline points="{pts}" fill="none" style="stroke:var({var})" stroke-width="2" stroke-linejoin="round"/>')
        for i, v in enumerate(vals):
            out.append(f'<circle cx="{xs(i):.1f}" cy="{y(v):.1f}" r="4.5" style="fill:var({var})" class="ring"><title>{esc(lab)} at {esc(xlabels[i])}: {v:.0f}%</title></circle>')
        out.append(f'<text x="{xs(len(vals) - 1) + 10:.1f}" y="{endpos[lab] + 4:.1f}" class="row-label" style="fill:var(--ink)">{esc(lab)}</text>')
    out.append('</svg>')
    return '\n'.join(out)


def scatter(points, xdom, ydom, ticks, xlabel, ylabel, width=640, height=420, labels=None, fit=None):
    """points: (label, x, y, lo, hi). y=x diagonal, optional fit line (slope, intercept)."""
    left, top, bottom, right = 48, 14, 44, 16
    xs = _scale(xdom[0], xdom[1], left, width - right)
    ys = _scale(ydom[0], ydom[1], height - bottom, top)
    out = [f'<svg viewBox="0 0 {width} {height}" class="chart" role="img" aria-label="{esc(ylabel)} against {esc(xlabel)}">']
    for t in ticks:
        if xdom[0] <= t <= xdom[1]:
            out.append(f'<line x1="{xs(t):.1f}" x2="{xs(t):.1f}" y1="{top}" y2="{height - bottom}" class="{"zero" if t == 0 else "grid"}"/><text x="{xs(t):.1f}" y="{height - bottom + 16}" class="tick" text-anchor="middle">{t:+d}</text>')
        if ydom[0] <= t <= ydom[1]:
            out.append(f'<line x1="{left}" x2="{width - right}" y1="{ys(t):.1f}" y2="{ys(t):.1f}" class="{"zero" if t == 0 else "grid"}"/><text x="{left - 6}" y="{ys(t) + 4:.1f}" class="tick" text-anchor="end">{t:+d}</text>')
    lo, hi = max(xdom[0], ydom[0]), min(xdom[1], ydom[1])
    out.append(f'<line x1="{xs(lo):.1f}" y1="{ys(lo):.1f}" x2="{xs(hi):.1f}" y2="{ys(hi):.1f}" class="ref-line"/>')
    out.append(f'<text x="{xs(hi) - 4:.1f}" y="{ys(hi) + 14:.1f}" class="ref-label" text-anchor="end">perfect calibration</text>')
    if fit:
        s, b = fit
        out.append(f'<line x1="{xs(xdom[0]):.1f}" y1="{ys(s * xdom[0] + b):.1f}" x2="{xs(xdom[1]):.1f}" y2="{ys(s * xdom[1] + b):.1f}" class="fit-line"/>')
        out.append(f'<text x="{xs(xdom[0]) + 4:.1f}" y="{ys(s * xdom[0] + b) + 18:.1f}" class="fit-label">measured trend, slope {s:.2f}</text>')
    out.append(f'<text x="{(left + width - right) / 2:.0f}" y="{height - 4}" class="axis-label" text-anchor="middle">{esc(xlabel)}</text>')
    out.append(f'<text x="12" y="{(top + height - bottom) / 2:.0f}" class="axis-label" text-anchor="middle" transform="rotate(-90 12 {(top + height - bottom) / 2:.0f})">{esc(ylabel)}</text>')
    for lab, px, py, plo, phi in points:
        if plo is not None and phi is not None:
            out.append(f'<line x1="{xs(px):.1f}" x2="{xs(px):.1f}" y1="{ys(max(ydom[0], plo)):.1f}" y2="{ys(min(ydom[1], phi)):.1f}" class="whisker"/>')
        out.append(f'<circle cx="{xs(px):.1f}" cy="{ys(py):.1f}" r="5.5" class="pt ring"><title>{esc(lab)}: predicted {px:+.0f}, measured {py:+.0f}</title></circle>')
        if labels and lab in labels:
            dx, anchor, dy = (labels[lab] + (0,))[:3]
            out.append(f'<text x="{xs(px) + dx:.1f}" y="{ys(py) + 4 + dy:.1f}" class="pt-label" text-anchor="{anchor}">{esc(lab)}</text>')
    out.append('</svg>')
    return '\n'.join(out)


def heat_table(rows, cols, cell, fmt, scale, title_fn=None, diverging=True, plain=()):
    """HTML table with color-mixed backgrounds. cell(r, c) -> value or None."""
    out = ['<div class="table-wrap"><table class="heat"><thead><tr><th></th>' + ''.join(f'<th>{esc(c)}</th>' for c in cols) + '</tr></thead><tbody>']
    for r in rows:
        tds = []
        for c in cols:
            v = cell(r, c)
            if v is None:
                tds.append('<td class="na">·</td>')
                continue
            if c in plain:
                tds.append(f'<td>{fmt(v)}</td>')
                continue
            a = min(1.0, abs(v) / scale)
            tok = ('--pos' if v >= 0 else '--neg') if diverging else '--accent'
            tip = f' title="{esc(title_fn(r, c, v))}"' if title_fn else ''
            tds.append(f'<td{tip} style="background:color-mix(in oklab, var({tok}) {round(a * 70)}%, var(--bg))" class="{"strong" if a > .6 else ""}">{fmt(v)}</td>')
        out.append(f'<tr><th>{esc(r)}</th>{"".join(tds)}</tr>')
    out.append('</tbody></table></div>')
    return '\n'.join(out)


def cards_html(s):
    """'AdQs' -> two playing-card chips."""
    out = []
    for i in range(0, len(s), 2):
        r, su = s[i], s[i + 1]
        sym = {'s': '♠', 'h': '♥', 'd': '♦', 'c': '♣'}[su]
        rk = '10' if r == 'T' else r
        out.append(f'<span class="pc {"red" if su in "hd" else ""}">{rk}{sym}</span>')
    return ''.join(out)
