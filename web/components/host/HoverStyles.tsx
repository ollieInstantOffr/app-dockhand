// Hover states from the design's `style-hover` attributes that have no global class.
const CSS = `
.fleet-card{transition:transform .3s cubic-bezier(.2,.8,.2,1),box-shadow .3s,opacity .3s}
.fleet-card:hover{transform:translateY(-4px) scale(1.01);box-shadow:var(--card-shadow-hover)!important}
.ctr-card{transition:transform .3s cubic-bezier(.2,.8,.2,1),box-shadow .3s,opacity .3s}
.ctr-card:hover{transform:translateY(-4px) scale(1.01);box-shadow:var(--card-shadow-hover)!important}
.tick-chip:hover{background:rgba(127,127,127,.32)!important}
.leg-row{transition:opacity .2s}
.ink-btn:hover{background:rgba(127,127,127,.22)!important;opacity:1!important}
.ink-fill:hover{background:rgba(127,127,127,.36)!important}
.upd-tag:hover{background:rgba(47,111,237,.2)!important}
.upd-btn:hover{background:rgba(47,111,237,.16)!important}
.bulk-btn:hover{background:rgba(255,255,255,.22)!important}
.bulk-x:hover{opacity:1!important}
.row-hover{transition:background .15s}
.row-hover:hover{background:var(--fill-2)!important}
.chip-hover{transition:background .15s}
.chip-hover:hover{background:var(--fill-2)!important}
.fill-hover{transition:background .15s,color .15s}
.fill-hover:hover:not(:disabled){background:var(--fill-2)!important;color:var(--ink)!important}
.danger-fill:hover{background:rgba(226,80,76,.12)!important}
.log-row:hover{background:rgba(255,255,255,.04)}
.dk-btn:hover{background:rgba(255,255,255,.14)!important}
.dk-seg:hover{color:#fff!important}
.term-tab:hover{color:#fff!important}
.term-x:hover{opacity:1!important;background:rgba(255,255,255,.12)}
.term-plus:hover{background:rgba(255,255,255,.08)!important;color:#fff!important}
.fact-row:hover{background:var(--fill-1)}
.btn-primary-sm:hover:not(:disabled){background:var(--btn-hover)!important}
.dk-menu-item:hover{background:rgba(255,255,255,.08)!important}
`;

export function HoverStyles() {
  return <style>{CSS}</style>;
}
